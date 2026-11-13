// The guided tour: one step per page, in sidebar order, said for someone who has never seen the
// product. A step with a path takes you to that page while you read about it.
export const STEPS = [
  { title: "Welcome to Kaho AI", text: "Kaho AI makes phone calls for you, with an AI that talks like a person. This short tour shows every part of the Studio, one page at a time. You can skip it at any moment." },
  { path: "dashboard", title: "Dashboard", text: "Your scoreboard. See how many calls were made, how many people picked up, and which calls went well. Start here each day." },
  { path: "calls", title: "Calls", text: "Place a call yourself. Choose an agent, a language and a number, type who to call, and press Call now. Past calls are listed below, with the recording and the written conversation." },
  { path: "live", title: "Live", text: "Watch calls happening right now. You can read what the agent and the person are saying as they say it." },
  { path: "bulk", title: "Bulk calls", text: "Call many people in one go. Upload a spreadsheet of names and numbers, pick an agent, and the system dials them for you, a few at a time, inside calling hours." },
  { path: "contacts", title: "Contacts", text: "Your address book. Keep names, numbers and tags here, record who agreed to be called, and mark anyone who must not be called. Press Call next to a name to ring them." },
  { path: "agents", title: "Agents", text: "An agent is the AI voice that makes your calls: its name, what it says first, which language it speaks and what it is allowed to do. Make one for each job, such as reminders or follow-ups." },
  { path: "prompts", title: "Prompts", text: "A prompt is the written brief you give an agent: who it is, what it knows and how it should behave. Every change is saved as a version, so you can go back." },
  { path: "numbers", title: "Numbers", text: "The phone numbers your calls come from. Add the number you rent from your phone provider here, so calls show a number people recognise." },
  { path: "team", title: "Team", text: "Everyone who works in your organization and what each person may do. Invite a teammate by sending them your invite code. They enter it when they sign up or sign in." },
  { path: "tasks", title: "Tasks", text: "Things that need doing after calls, such as calling someone back. Add them, tick them off and keep nothing in your head." },
  { path: "your-tools", title: "Your own tools", text: "Teach an agent to do more than talk, such as saving a customer's answer or looking something up. Describe what you need to Kaho Builder in plain words and it builds the tool for you." },
  { path: "tags", title: "Tags", text: "Coloured labels for your contacts, like Priority or Follow up. Use them to find and group people quickly." },
  { path: "errors", title: "Error Logs", text: "If something goes wrong during a call, it appears here in plain words. Read it, fix it if needed, then press Acknowledge to move it out of the way." },
  { path: "settings", title: "Settings", text: "The rules for your whole organization: calling hours, who can do what, keys for other systems, usage, a health check and a record of every change." },
  { title: "You are ready", text: "That is everything. You can run this tour again any time from the question mark at the top right. Good calling!" },
];
