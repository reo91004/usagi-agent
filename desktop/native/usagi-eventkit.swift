// 우사기 EventKit 도우미(#53): 이 Mac 의 캘린더·미리알림을 JSON 한 줄로 낸다. 데몬(agent/src/eventkit.ts)이 부른다.
//   usagi-eventkit status                       권한 상태
//   usagi-eventkit request                      캘린더·미리알림 권한을 묻는다(처음 한 번 macOS 창)
//   usagi-eventkit events <from ISO> <to ISO>   그 기간 일정(메모 본문은 내지 않고 회의 링크만 뽑는다)
//   usagi-eventkit reminders <since ISO> [id…]  안 끝난 미리알림 전부 + since 뒤에 끝낸 것 + 이어 둔 id 의 지금 모습(linked, 없어진 것은 빠진다)
//   usagi-eventkit write <ops JSON>             미리알림 쓰기(add·set·delete)를 차례로 하고 한 번에 저장한다
// 캘린더는 쓰지 않는다. 미리알림 쓰기는 write 하나뿐이고 데몬은 양방향을 켰을 때만 부른다.
// 권한 창은 앱(우사기.app)의 Info.plist 문구로 뜬다(데몬이 앱의 자식이라 앱 이름으로)
import EventKit
import Foundation

nonisolated(unsafe) let store = EKEventStore() // 이 도우미는 한 번 돌고 끝나는 단일 흐름이라 동시 접근이 없다

func emit(_ v: Any) {
  let d = (try? JSONSerialization.data(withJSONObject: v, options: [])) ?? Data("{\"ok\":false,\"error\":\"json\"}".utf8)
  FileHandle.standardOutput.write(d)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

// 0 notDetermined · 1 restricted · 2 denied · 3 fullAccess(예전 authorized) · 4 writeOnly
func statusName(_ t: EKEntityType) -> String {
  switch EKEventStore.authorizationStatus(for: t).rawValue {
  case 0: return "notDetermined"
  case 1: return "restricted"
  case 2: return "denied"
  case 3: return "granted"
  case 4: return "writeOnly"
  default: return "unknown"
  }
}
func granted(_ t: EKEntityType) -> Bool { EKEventStore.authorizationStatus(for: t).rawValue == 3 }

func ask(_ t: EKEntityType) async -> Bool {
  if #available(macOS 14.0, *) {
    do { return t == .event ? try await store.requestFullAccessToEvents() : try await store.requestFullAccessToReminders() } catch { return false }
  }
  return await withCheckedContinuation { c in store.requestAccess(to: t) { ok, _ in c.resume(returning: ok) } }
}

let isoOut: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
func parseIso(_ s: String) -> Date? {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  f.formatOptions = [.withInternetDateTime]
  return f.date(from: s)
}

// 회의 링크(Meet·Zoom·Teams·Webex)만 뽑는다. 메모 본문 자체는 내보내지 않는다
let joinRe = try! NSRegularExpression(pattern: "https://(meet\\.google\\.com|[\\w.-]*zoom\\.us|teams\\.microsoft\\.com|teams\\.live\\.com|[\\w.-]*webex\\.com)/[^\\s<>\"')]+", options: [.caseInsensitive])
func joinUrl(_ texts: [String?]) -> String? {
  for t in texts.compactMap({ $0 }) {
    let r = NSRange(t.startIndex..., in: t)
    if let m = joinRe.firstMatch(in: t, range: r), let rr = Range(m.range, in: t) { return String(t[rr]) }
  }
  return nil
}

func events(_ from: Date, _ to: Date) -> [[String: Any]] {
  let pred = store.predicateForEvents(withStart: from, end: to, calendars: store.calendars(for: .event))
  return store.events(matching: pred).map { e in
    var d: [String: Any] = [
      "id": e.eventIdentifier ?? e.calendarItemIdentifier,
      "title": e.title ?? "",
      "start": isoOut.string(from: e.startDate),
      "end": isoOut.string(from: e.endDate),
      "allDay": e.isAllDay,
      "cancelled": e.status == .canceled,
      "free": e.availability == .free,
      "calendar": e.calendar?.title ?? "",
    ]
    if let uid = e.calendarItemExternalIdentifier { d["uid"] = uid }
    if let loc = e.location, !loc.isEmpty { d["location"] = loc }
    if let u = joinUrl([e.url?.absoluteString, e.location, e.notes]) { d["join"] = u }
    if let att = e.attendees {
      d["attendees"] = att.filter { !$0.isCurrentUser }.count
      if let me = att.first(where: { $0.isCurrentUser }) {
        switch me.participantStatus {
        case .accepted: d["response"] = "accepted"
        case .declined: d["response"] = "declined"
        case .tentative: d["response"] = "tentativelyaccepted"
        case .pending: d["response"] = "notresponded"
        default: break
        }
      }
    }
    if e.organizer?.isCurrentUser == true { d["organizer"] = true }
    return d
  }
}

func fetch(_ pred: NSPredicate) async -> [EKReminder] {
  await withCheckedContinuation { c in store.fetchReminders(matching: pred) { rs in c.resume(returning: rs ?? []) } }
}
func reminderDict(_ r: EKReminder) -> [String: Any] {
  var d: [String: Any] = ["id": r.calendarItemIdentifier, "title": r.title ?? "", "list": r.calendar?.title ?? "", "priority": r.priority, "completed": r.isCompleted]
  if let c = r.dueDateComponents, let due = Calendar.current.date(from: c) {
    d["due"] = isoOut.string(from: due)
    d["dueHasTime"] = c.hour != nil
  }
  if let done = r.completionDate { d["completedAt"] = isoOut.string(from: done) }
  if let u = r.url?.absoluteString { d["url"] = u }
  return d
}

// write 의 add 가 넣는 목록: 이름이 같은 쓸 수 있는 목록, 없으면 기본 목록과 같은 계정에 만든다(만들기 실패는 한 번만 해 본다)
var listsByName: [String: EKCalendar] = [:]
var listError: Error?
func reminderList(_ name: String) throws -> EKCalendar {
  if let c = listsByName[name] { return c }
  if let e = listError { throw e }
  if let c = store.calendars(for: .reminder).first(where: { $0.title == name && $0.allowsContentModifications }) { listsByName[name] = c; return c }
  guard let src = store.defaultCalendarForNewReminders()?.source else { throw NSError(domain: "usagi", code: 1, userInfo: [NSLocalizedDescriptionKey: "기본 미리알림 목록이 없어요"]) }
  let c = EKCalendar(for: .reminder, eventStore: store)
  c.title = name
  c.source = src
  do { try store.saveCalendar(c, commit: true) } catch { listError = error; throw error }
  listsByName[name] = c
  return c
}
func reminder(_ id: Any?) -> EKReminder? { (id as? String).flatMap { store.calendarItem(withIdentifier: $0) as? EKReminder } }
// 마감: ISO 면 그 날(dueHasTime 이면 시각까지), null 이면 지운다
func setDue(_ r: EKReminder, _ o: [String: Any]) {
  guard o.keys.contains("due") else { return }
  r.dueDateComponents = (o["due"] as? String).flatMap(parseIso).map {
    Calendar.current.dateComponents(o["dueHasTime"] as? Bool == true ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day], from: $0)
  }
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "status":
  emit(["ok": true, "calendar": statusName(.event), "reminders": statusName(.reminder)])
case "request":
  let cal = await ask(.event)
  let rem = await ask(.reminder)
  emit(["ok": cal || rem, "calendar": statusName(.event), "reminders": statusName(.reminder)])
case "events":
  guard args.count >= 4, let from = parseIso(args[2]), let to = parseIso(args[3]) else { emit(["ok": false, "error": "usage: events <from> <to>"]); exit(2) }
  guard granted(.event) else { emit(["ok": false, "error": "not-granted", "calendar": statusName(.event)]); exit(0) }
  emit(["ok": true, "events": events(from, to)])
case "reminders":
  guard args.count >= 3, let since = parseIso(args[2]) else { emit(["ok": false, "error": "usage: reminders <since>"]); exit(2) }
  guard granted(.reminder) else { emit(["ok": false, "error": "not-granted", "reminders": statusName(.reminder)]); exit(0) }
  let lists = store.calendars(for: .reminder)
  let open = await fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
  let done = await fetch(store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: Date(), calendars: lists))
  let linked = args.dropFirst(3).compactMap { reminder($0) }
  emit(["ok": true, "open": open.map(reminderDict), "completed": done.map(reminderDict), "linked": linked.map(reminderDict)])
case "write":
  // ops: [{op:"add", list, title, priority?, due?, dueHasTime?, url?} | {op:"set", id, title?, done?, due?(null 이면 지움), dueHasTime?} | {op:"delete", id}] → results 같은 순서
  guard args.count >= 3, let ops = (try? JSONSerialization.jsonObject(with: Data(args[2].utf8))) as? [[String: Any]] else { emit(["ok": false, "error": "usage: write <ops JSON>"]); exit(2) }
  guard granted(.reminder) else { emit(["ok": false, "error": "not-granted", "reminders": statusName(.reminder)]); exit(0) }
  var results: [[String: Any]] = []
  var made: [(Int, EKReminder)] = []
  for o in ops {
    do {
      switch o["op"] as? String {
      case "add":
        let r = EKReminder(eventStore: store)
        r.calendar = try reminderList(o["list"] as? String ?? "우사기 비서")
        r.title = o["title"] as? String ?? ""
        if let p = o["priority"] as? Int { r.priority = p }
        setDue(r, o)
        if let u = (o["url"] as? String).flatMap(URL.init(string:)) { r.url = u }
        try store.save(r, commit: false)
        made.append((results.count, r))
        results.append(["ok": true])
      case "set":
        guard let r = reminder(o["id"]) else { results.append(["ok": false, "missing": true]); continue }
        if let t = o["title"] as? String { r.title = t }
        if let d = o["done"] as? Bool { r.isCompleted = d }
        setDue(r, o)
        try store.save(r, commit: false)
        results.append(["ok": true])
      case "delete":
        if let r = reminder(o["id"]) { try store.remove(r, commit: false) } // 이미 없으면 그대로 성공
        results.append(["ok": true])
      default:
        results.append(["ok": false, "error": "unknown op"])
      }
    } catch { results.append(["ok": false, "error": error.localizedDescription]) }
  }
  do { try store.commit() } catch { emit(["ok": false, "error": error.localizedDescription]); exit(0) }
  for (i, r) in made { results[i]["id"] = r.calendarItemIdentifier } // 새 id 는 저장한 뒤에 읽는다
  emit(["ok": true, "results": results])
default:
  emit(["ok": false, "error": "usage: usagi-eventkit status|request|events <from> <to>|reminders <since> [id…]|write <ops>"])
  exit(2)
}
