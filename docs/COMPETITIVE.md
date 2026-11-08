# How Kaho AI compares with Bolna and Bland

Written 2026-11-08. **What is sourced and what is not:** the facts about Bolna and Bland below come from
their own documentation and from third-party reviews found by search that day (links at the end), and
the pages disagreed with each other in places. Anything marked *(general knowledge)* is common in the
voice-agent market but was not confirmed in these sources. **"Agni AI":** the search found one
documentation site called Agni, describing a conversational voice model with an API and usage-based
pricing. It said nothing about telephony, India or calling, and no other source named it, so it is left
out rather than guessed at. Check the product you meant and tell me.

## What the other two say they do

**Bolna** (India-first). Agents are built in an Agent Studio: prompt, model, voice, languages, tools and a
knowledge base. Phone and web conversations in 40+ languages, inbound, outbound, batch campaigns and in
the browser. Multi-step flows through "graph agents". Call settings include voicemail detection, keypad
(DTMF) input and call timeouts. Tool calling, call transfer, calendar slot checking and booking, custom
function calls, structured data extraction, guardrails and variables. An API-first platform (Agent, Call,
Executions and Batches APIs), sub-accounts, and on-premise deployment for enterprise customers. It claims
the whole pipeline runs in under 600ms.

**Bland.** "Pathways": a visual, node-based designer for branching multi-turn phone workflows with state,
tool calls and variable extraction. Batch calling from a CSV through an API, with campaigns that can be
stopped mid-flight. Call logs with filtering, an analytics dashboard, and an in-console assistant that
answers analytics questions in plain English.

## Where Kaho AI stands

**On par, or ahead, for an India-first product**
- Prompt, tools, voice and language per agent; Hindi, English and Hinglish with the voice following the caller.
- Your own tools that call your system, and questions the agent writes down, both with a test button.
- A draft and publish flow with version history and one-click rollback, and a test that must pass first.
  Neither source mentions anything like this.
- A chat assistant that sets tools and questions up from plain words, typed or spoken. Not seen in either.
- Batch calls, with calling hours, Do Not Call and consent built in for TRAI, and an organization-wide
  calling-hours rule an admin controls.
- Live transcript, recordings with playback, a transcript download, per-agent call history, tool history.
- Six roles with an access table, API keys, and masked personal data on disk.
- Measured reply time of roughly one second from the end of a caller's sentence.

**Missing, in rough order of how much a user would feel it**
1. **A knowledge base.** Upload a price list or FAQ and the agent answers from it. Both platforms have this
   *(Bolna sourced; Bland general knowledge)*. Today an agent only knows its prompt.
2. **Starter templates.** "EMI reminder", "appointment confirmation", "lead qualification", ready to edit.
   Cheap to build and the fastest route to a first working agent *(general knowledge)*.
3. **Talk to your agent in the browser.** Bolna offers browser conversations. Our test is typed. A button
   that opens a web call removes the need for a phone and a number to try an agent.
4. **A post-call webhook and structured results.** After each call, send the outcome, the saved answers and
   a summary to the customer's own system, and let them define the fields to extract. Bolna lists
   structured extraction and an Executions API; this is what makes a voice agent useful inside a business.
5. **A public API beyond tasks and contacts.** Place a call, fetch a call and its transcript, start a batch,
   manage agents, with a documentation page. Both platforms are API-first.
6. **Voicemail detection and keypad (DTMF) input.** Bolna lists both. A call that reaches voicemail is
   currently talked to, and an "press 1 for yes" flow is impossible.
7. **More Indian languages.** Bolna claims 40+. We do Hindi and English; Tamil, Telugu, Bengali, Marathi,
   Gujarati and Kannada need a speech recogniser that supports them (the one in use does not).
8. **Campaign rules.** Retry a no-answer after some hours, a daily cap, scheduled starts, a pause when the
   answer rate drops. We dial a list once.
9. **Calendar booking and a smarter handoff.** Bolna lists calendar slot checks and booking. Our transfer
   goes to one fixed number with no context passed on.
10. **Integrations.** Google Sheets, a CRM, and above all WhatsApp or SMS after a call, which matters a
    great deal in India *(general knowledge)*.
11. **Flow designer.** Bland's Pathways and Bolna's graph agents give strict control of what is said in what
    order. Prompt-only agents drift; a flow suits compliance-heavy scripts like collections.
12. **Usage and billing.** Minutes and cost per organization, a wallet or invoice. Bolna's FAQ lists a
    per-minute platform fee (the page may be out of date). We record cost per call but do not meter or bill.
13. **Quality and QA.** Sentiment, a pass or fail score per call, alerts when calls go wrong, a supervisor
    who can listen in *(general knowledge)*.
14. **Compliance depth.** A full audit log of who changed what (we have a notification feed, not a record),
    two-step sign-in, and a recorded-consent trail for DPDP. Hosting in Mumbai is planned but not done.

## What I would build next, and why

1. **Templates, then browser test calls.** Together they take a new customer from sign-up to hearing their
   own agent in minutes, and they are the first thing anyone compares.
2. **Knowledge base, then the post-call webhook.** These two are what turn a demo into something a
   business keeps using.
3. **Voicemail detection, retries and scheduled campaigns.** Without them outbound calling wastes money
   and annoys people, and collections work lives on them.
4. **WhatsApp follow-up and more languages.** The widest gap between a good demo and a product India uses.

None of these has been started. Say which to take first.

## Sources
- Bolna documentation: https://www.bolna.ai/docs/platform-concepts.md, https://docs.bolna.ai/introduction,
  https://docs.bolna.ai/frequently-asked-questions
- Bland documentation and changelog: https://docs.bland.ai/llms.txt, https://bland.ai/changelog
- Third-party reviews of Bland (secondary, less authoritative):
  https://www.coval.dev/blog/bland-ai-review-2026-features-pricing-and-when-to-use-it,
  https://www.retellai.com/blog/bland-ai-reviews
- Agni documentation (unconfirmed as the product meant): https://agni-docs-frontend.vercel.app

## Status update, 2026-11-08 (later)

Built since the list above: **starter templates**, **knowledge base** (documents the agent searches mid-call),
**call webhook** (signed, with summary, answers and sentiment), **public API** (agents, place a call, list and
fetch calls), **campaign retries** (up to 3, 1 to 24 hours apart, only after no answer), **voicemail hang-up**
(Plivo machine detection; off by default, untried on a real call), **usage** (minutes by day and agent),
and **call review** (happy, neutral or unhappy).
Still missing: browser test calls, keypad (DTMF) input, more Indian languages, calendar booking,
WhatsApp or SMS follow-up, a flow designer, billing, and a full audit log.
