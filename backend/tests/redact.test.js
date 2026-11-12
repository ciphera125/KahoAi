import { describe, expect, it } from "vitest";
import { redactPII } from "../src/models/redact.js";

describe("what is kept out of the files in Storage", () => {
  it("removes e-mail addresses", () => {
    expect(redactPII("mail me at ravi.k+loan@gmail.com please")).toBe("mail me at [email] please");
  });
  it("removes phone numbers however they are written, but not dates, amounts or short numbers", () => {
    expect(redactPII("call 9876543210 or +91 98765 43210 or 098-7654-3210")).toBe("call [number] or [number] or [number]");
    expect(redactPII("the date is 2026-12-05, EMI 5,00,000 rupees, 4 people, 1234")).toBe("the date is 2026-12-05, EMI 5,00,000 rupees, 4 people, 1234");
  });
  it("removes long number runs of any kind (card, account, Aadhaar that slipped through)", () => {
    expect(redactPII("account 123456789012 and 4111 1111 1111 1111")).toBe("account [number] and [number]");
  });
  it("leaves already masked values as they are", () => {
    expect(redactPII("Aadhaar XXXX XXXX 1234 and PAN XXXXX1234X")).toBe("Aadhaar XXXX XXXX 1234 and PAN XXXXX1234X");
  });
  it("removes a PAN that slipped through", () => {
    expect(redactPII("my PAN is ABCDE1234F ok")).toBe("my PAN is [PAN] ok");
  });
  it("removes the names it is told about, whole words only, any case, and their parts", () => {
    expect(redactPII("Hello Ravi Kumar, is this ravi? Kumari is fine", { names: ["Ravi Kumar"] })).toBe("Hello [name] [name], is this [name]? Kumari is fine");
  });
  it("ignores names too short to remove safely, and a name that is a common word is still only removed whole", () => {
    expect(redactPII("Al is here", { names: ["Al"] })).toBe("Al is here");
  });
  it("does not choke on nothing, on non-text, or on very long text", () => {
    expect(redactPII("")).toBe("");
    expect(redactPII(null)).toBe("");
    expect(redactPII(undefined)).toBe("");
    const long = "9".repeat(100000);
    expect(redactPII(long)).toBe("[number]");
  });
  it("is the same when run twice", () => {
    const once = redactPII("9876543210 a@b.co Ravi", { names: ["Ravi"] });
    expect(redactPII(once, { names: ["Ravi"] })).toBe(once);
  });
});

describe("the gaps found in the first version are closed", () => {
  const year = new Date().getFullYear();

  it("catches digits spoken as words, in English and Hindi", () => {
    expect(redactPII("my number is nine eight seven six five four three two one zero thanks")).toBe("my number is [number] thanks");
    expect(redactPII("number hai nau aath saat chhe paanch char teen do ek shunya")).toBe("number hai [number]");
    expect(redactPII("नंबर है नौ आठ सात छह पांच चार तीन दो एक शून्य")).toBe("नंबर है [number]");
    expect(redactPII("one two three")).toBe("one two three"); // a few number words are not a number
    expect(redactPII("I have two or three questions, one at a time")).toBe("I have two or three questions, one at a time");
  });

  it("catches digits written in other scripts and full-width digits", () => {
    expect(redactPII("मेरा नंबर ९८७६५४३२१०")).toBe("मेरा नंबर [number]");
    expect(redactPII("নম্বর ৯৮৭৬৫৪৩২১০")).toBe("নম্বর [number]");
    expect(redactPII("９８７６５４３２１０")).toBe("[number]");
  });

  it("catches a number said across turns, without losing the turn lines", () => {
    const t = "[10:25:12 am] Agent: Your number?\n[10:25:20 am] Caller: 98765\n[10:25:30 am] Caller: 43210\n[10:25:40 am] Agent: Thanks";
    const out = redactPII(t);
    expect(out).not.toMatch(/9876|4321/);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toContain("[10:25:20 am] Caller: [number]");
    expect(out).toContain("[10:25:30 am] Caller: [number]");
  });

  it("does not treat two separate short answers as a number when the agent spoke between them", () => {
    const t = "[1:00:00 pm] Caller: 12345\n[1:00:05 pm] Agent: And your age?\n[1:00:09 pm] Caller: 4321";
    expect(redactPII(t)).toBe(t);
  });

  it("catches an e-mail address spoken aloud", () => {
    expect(redactPII("it is ravi dot kumar at gmail dot com ok")).toBe("it is [email] ok");
    expect(redactPII("ravi at the rate gmail dot com")).toBe("[email]");
    expect(redactPII("meet me at noon dot dot dot")).toBe("meet me at noon dot dot dot");
    expect(redactPII("look at the dot com boom")).toBe("look at the dot com boom");
  });

  it("catches an e-mail written with a full-width @, and a UPI id with no dot", () => {
    expect(redactPII("ravi＠gmail.com")).toBe("[email]");
    expect(redactPII("pay ravi@okaxis please")).toBe("pay [email] please");
    expect(redactPII("pay 9876543210@ybl")).toBe("pay [email]");
  });

  it("catches a date of birth in any common form, but keeps recent dates", () => {
    expect(redactPII("born 12/03/1985")).toBe("born [date]");
    expect(redactPII("dob 1985-03-12")).toBe("dob [date]");
    expect(redactPII("on 12 March 1985 in Pune")).toBe("on [date] in Pune");
    expect(redactPII("March 12, 1985")).toBe("[date]");
    expect(redactPII("born in 1985")).toBe("born in [date]");
    expect(redactPII(`EMI on ${year}-12-05 and ${year - 1}-04-01 and 5 December ${year}`)).toBe(`EMI on ${year}-12-05 and ${year - 1}-04-01 and 5 December ${year}`);
  });

  it("catches a misspelt contact name (one letter wrong or two swapped), not a different word", () => {
    expect(redactPII("Ravy Kumar and Rvai", { names: ["Ravi Kumar"] })).toBe("[name] [name] and [name]");
    expect(redactPII("Kumari and Ravish", { names: ["Ravi Kumar"] })).toBe("Kumari and Ravish");
  });

  it("catches a name the caller gives for themselves", () => {
    expect(redactPII("Caller: my name is Priya Sharma and I need a loan")).toBe("Caller: my name is [name] and I need a loan");
    expect(redactPII("Hi, this is Anil Mehta from Pune")).toBe("Hi, this is [name] from Pune");
    expect(redactPII("मेरा नाम प्रिया शर्मा है")).toBe("मेरा नाम [name] है");
    expect(redactPII("this is great news")).toBe("this is great news");
    expect(redactPII("my name is not on the list")).toBe("my name is not on the list");
  });

  it("still leaves ordinary sentences, amounts and times alone", () => {
    const text = "[3:05:09 pm] Caller: I can pay 25,000 rupees on the 5th, around 4 pm, for 12 months";
    expect(redactPII(text)).toBe(text);
  });

  it("is still the same when run twice", () => {
    const once = redactPII("ravi at gmail dot com 98765 43210 born 12/03/1985 my name is Priya Sharma ९८७६५४३२१०", { names: ["Ravi"] });
    expect(redactPII(once, { names: ["Ravi"] })).toBe(once);
  });
});

describe("it stays fast on hostile or very long text", () => {
  const took = (text, opts) => { const t = Date.now(); const out = redactPII(text, opts); return { ms: Date.now() - t, out }; };
  it("handles a hundred thousand digits, spaced digits, number words and dots in well under a second", () => {
    for (const text of ["9".repeat(100000), "9 ".repeat(50000), "one ".repeat(50000), "a dot ".repeat(16000), "ravi at ".repeat(12000),
      "[1:00:00 pm] Caller: 12\n".repeat(5000), "my name is Aa Bb Cc ".repeat(5000)]) {
      expect(took(text).ms).toBeLessThan(1000);
    }
  });
  it("catches a number said partly in digits and partly in words", () => {
    expect(redactPII("98765 four three two one")).toBe("[number]");
    expect(redactPII("it is 98765 four ok")).toBe("it is 98765 four ok");
  });
  it("does not take a crore written with commas, or a list of short numbers, for a phone number", () => {
    expect(redactPII("loan of 1,00,00,000 rupees")).toBe("loan of 1,00,00,000 rupees");
    expect(redactPII("12 months, 5 people and 3 branches")).toBe("12 months, 5 people and 3 branches");
  });
});

describe("the agent's own introduction is not hidden", () => {
  it("leaves 'this is Ria' on an Agent line, and hides the same words on a Caller line", () => {
    const t = "[1:00:00 pm] Agent: Hello, this is Ria from Kaho AI\n[1:00:05 pm] Caller: hi, this is Anil Mehta";
    expect(redactPII(t)).toBe("[1:00:00 pm] Agent: Hello, this is Ria from Kaho AI\n[1:00:05 pm] Caller: hi, this is [name]");
  });
  it("can be told a piece of text is the agent's", () => {
    expect(redactPII("Hello, this is Ria", { selfIntro: false })).toBe("Hello, this is Ria");
    expect(redactPII("Hello, this is Ria")).toBe("Hello, this is [name]");
  });
  it("still hides the contact's own name on an Agent line", () => {
    expect(redactPII("[1:00:00 pm] Agent: Hello Ravi, this is Ria", { names: ["Ravi"] })).toBe("[1:00:00 pm] Agent: Hello [name], this is Ria");
  });
});

describe("numbers said the Indian way", () => {
  it("catches 'double' and 'triple' inside a spoken number", () => {
    expect(redactPII("nine eight double seven six five triple four three")).toBe("[number]");
    expect(redactPII("number is 98 double 7 65 triple 4 3")).toBe("number is [number]");
  });
  it("does not take ordinary use of the word for a number", () => {
    expect(redactPII("a double room for two, triple checked")).toBe("a double room for two, triple checked");
  });
});
