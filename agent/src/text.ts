// 글 자르기·한 줄로 접기 공용 도우미
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// 값(널 가능)을 글로 바꿔 공백을 접고 자른다
export const clipText = (s: unknown, n: number) => clip(oneLine(String(s ?? "")), n);
