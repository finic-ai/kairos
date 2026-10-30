export type Message = { ok: boolean; text: string } | null;

export const Banner = ({ message }: { message: Message }) =>
  message ? <div className={`banner ${message.ok ? "ok" : ""}`}>{message.text}</div> : null;
