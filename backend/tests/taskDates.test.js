// Dates and times a caller says for a task (2026-11-22). The tool told the model to pass the date "as they
// said it", and the reader only knew a weekday when it came first: "on Friday", "this Friday" and
// "coming Monday" were refused, so the agent asked the caller again for no reason. A time said out loud
// ("tomorrow at 5 pm") was dropped and the reminder set for 9 a.m.
import { describe, expect, it } from "vitest";
import { parseAnswer, parseTaskDue } from "../src/models/answerValue.js";

// Monday 9 November 2026, 15:30 India time.
const NOW = new Date("2026-11-09T10:00:00Z");
const date = (text) => parseAnswer("date", text, { now: NOW });
const due = (text) => parseTaskDue(text, { now: NOW });
const ist = (r) => (r.ok ? new Date(r.value.getTime() + 5.5 * 3600000).toISOString().slice(0, 16).replace("T", " ") : r);

describe("a weekday, however it is put", () => {
  it("reads 'on', 'this', 'coming', 'by' and 'for' before a weekday", () => {
    for (const said of ["on Friday", "this Friday", "coming Friday", "by Friday", "for friday", "upcoming Friday", "Friday evening"]) {
      expect(date(said), said).toMatchObject({ ok: true, value: "2026-11-13" });
    }
    expect(date("by next Friday")).toMatchObject({ value: "2026-11-20" });
    expect(date("by tomorrow")).toMatchObject({ value: "2026-11-10" });
  });

  it("an exact date wins over a weekday said beside it", () => {
    expect(date("Tuesday 15 December")).toMatchObject({ value: "2026-12-15" });
    expect(date("15/12/2026, a Tuesday")).toMatchObject({ value: "2026-12-15" });
  });

  it("counts days ahead in English and Hindi", () => {
    expect(date("in 3 days")).toMatchObject({ value: "2026-11-12" });
    expect(date("after 2 days")).toMatchObject({ value: "2026-11-11" });
    expect(date("10 din baad")).toMatchObject({ value: "2026-11-19" });
    expect(date("in 1000 days")).toMatchObject({ ok: false });
  });

  it("still refuses what it cannot be sure of", () => {
    expect(date("next week")).toMatchObject({ ok: false });
    expect(date("not tomorrow, the 15th")).toMatchObject({ value: "2026-11-15" });
  });
});

describe("the time of day for a task", () => {
  it("is 9 in the morning of that day when no time is said", () => {
    expect(ist(due("Friday"))).toBe("2026-11-13 09:00");
    expect(due("Friday")).toMatchObject({ ok: true, day: "2026-11-13", time_said: false });
  });

  it("keeps a time said with am or pm, before or after the day", () => {
    expect(ist(due("tomorrow at 5 pm"))).toBe("2026-11-10 17:00");
    expect(ist(due("5pm tomorrow"))).toBe("2026-11-10 17:00");
    expect(ist(due("Friday 10:30 am"))).toBe("2026-11-13 10:30");
    expect(ist(due("on the 15th at 12 pm"))).toBe("2026-11-15 12:00");
    expect(ist(due("tomorrow 12 am"))).toBe("2026-11-10 00:00");
    expect(ist(due("tomorrow 6.45 p.m."))).toBe("2026-11-10 18:45");
  });

  it("reads a 24-hour time, and the Hindi parts of the day", () => {
    expect(ist(due("tomorrow 17:30"))).toBe("2026-11-10 17:30");
    expect(ist(due("kal shaam 6 baje"))).toBe("2026-11-10 18:00");
    expect(ist(due("kal subah 10 baje"))).toBe("2026-11-10 10:00");
    expect(ist(due("parso dopahar 2 baje"))).toBe("2026-11-11 14:00");
    expect(ist(due("kal raat 9 baje"))).toBe("2026-11-10 21:00");
    expect(ist(due("tomorrow 7 in the evening"))).toBe("2026-11-10 19:00");
    expect(ist(due("Friday morning 8"))).toBe("2026-11-13 08:00");
  });

  it("asks morning or evening rather than guess a bare hour", () => {
    for (const said of ["tomorrow at 5", "kal 6 baje", "Friday 7:30"]) {
      const r = due(said);
      expect(r.ok, said).toBe(false);
      expect(r.message).toMatch(/morning or the evening/);
    }
  });

  it("a time alone is today, and a time today that has gone is refused", () => {
    expect(ist(due("at 6 pm"))).toBe("2026-11-09 18:00");
    const gone = due("today at 9 am");
    expect(gone.ok).toBe(false);
    expect(gone.message).toMatch(/already gone/);
  });

  it("never mistakes a date for a time", () => {
    expect(ist(due("at 15 December"))).toBe("2026-12-15 09:00");
    expect(ist(due("15 December at 4 pm"))).toBe("2026-12-15 16:00");
    expect(ist(due("5 tarikh"))).toBe("2026-12-05 09:00");
    expect(ist(due("in 3 days"))).toBe("2026-11-12 09:00");
    expect(ist(due("on the 15th"))).toBe("2026-11-15 09:00");
  });

  it("refuses an hour that does not exist", () => {
    expect(due("tomorrow at 13 pm")).toMatchObject({ ok: false });
    expect(due("tomorrow 25:00")).toMatchObject({ ok: false });
  });

  it("refuses a day it cannot read, as before", () => {
    expect(due("sometime")).toMatchObject({ ok: false });
    expect(due("sometime").message).toMatch(/exact date/);
  });
});
