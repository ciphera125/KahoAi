export function callsUrl({ page, perPage, q }) {
  const text = String(q ?? "").trim();
  return `/api/calls?page=${page}&per_page=${perPage}${text ? `&q=${encodeURIComponent(text)}` : ""}`;
}

export function recordingMessage(err) {
  if (err?.status === 404) return "There is no recording for this call.";
  if (err?.status === 503) return "Recordings are not set up on this server yet.";
  return "Could not load the recording. Try again.";
}
