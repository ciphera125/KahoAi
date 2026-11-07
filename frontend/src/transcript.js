// The live transcript's messages. The phone server sends the agent's words one at a time
// as it speaks, and the caller's words as a growing guess; both are captions ("live"),
// and the finished sentence arrives later as a "turn". One bubble per speaker's stretch,
// like a chat app: agent words are joined, the caller's guess replaces the earlier one,
// and a finished turn replaces that speaker's captions.
export function messages(events) {
  const out = [];
  for (const e of events) {
    if (e.event === "live") {
      const last = out[out.length - 1];
      if (last && last.event === "live" && last.role === e.role) {
        last.text = e.role === "agent" ? `${last.text} ${e.text}` : e.text;
      } else {
        out.push({ ...e });
      }
      continue;
    }
    if (e.event === "turn") {
      // Drop this speaker's captions since their last finished turn.
      let i = out.length;
      while (i > 0 && !(out[i - 1].event === "turn" && out[i - 1].role === e.role)) i--;
      for (let j = out.length - 1; j >= i; j--) if (out[j].event === "live" && out[j].role === e.role) out.splice(j, 1);
    }
    out.push(e);
  }
  return out;
}
