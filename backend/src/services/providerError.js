// Provider failures in plain words, for people who are not engineers. A provider's own error
// text (a JSON body, an api_id, an HTTP code) is never shown: it says nothing a person can act on,
// and can echo account details. The words below say what happened, what to do, and whether
// anything was done (a call placed, a message sent).

const NOTHING = "No call was placed.";

/** What a person should read when `provider` answered `status` with `body`. Null if we have no plain wording. */
export function plainProviderError(provider, status, body = "") {
  const text = String(body).toLowerCase();
  const name = provider;
  if (status === 402 || /insufficient|no balance|out of credit|quota exceeded|billing/.test(text)) {
    return `${name} has insufficient balance. Add credit in the ${name} console, then try again. ${NOTHING}`;
  }
  if (status === 401 || status === 403) {
    return `${name} rejected the account details saved here. Check the Auth ID and Auth token on Numbers. ${NOTHING}`;
  }
  if (status === 429) return `${name} is limiting this account for a moment. Wait a minute, then try again. ${NOTHING}`;
  if (status >= 500) {
    return `${name} is having a problem on its side. Try again in a few minutes. Check ${name}'s call log first, `
      + "in case the call was placed.";
  }
  return null;
}
