// One call, opened: who it was with, the recording to play, the transcript to read, and the
// ways to download them. Used on the Calls page and on an agent's Call history, so a call
// looks and works the same wherever it is opened from.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { get } from "../api.js";
import { recordingMessage } from "../recording.js";
import { fmtDur, Icon, Modal, whenShort } from "../ui.jsx";

/** What the agent wrote down on this call, as a plain list. */
function SavedAnswers({ callId }) {
  const [answers, setAnswers] = useState(null);
  useEffect(() => { get(`/api/calls/${encodeURIComponent(callId)}/answers`).then(setAnswers).catch(() => setAnswers([])); }, [callId]);
  if (!answers?.length) return null;
  return (
    <div className="answers">
      <div className="card-title" style={{ marginBottom: 6 }}>Saved on this call</div>
      {answers.map((a) => (
        <div key={a.id} className="answer-line">
          <span className="muted">{a.label}</span>
          <b>{a.value}</b>
          {a.raw_text && a.raw_text !== a.value && <span className="hint">heard: “{a.raw_text}”</span>}
        </div>
      ))}
    </div>
  );
}

/** The player. Nothing is fetched until "Play recording" is pressed: a signed link only
 * lasts ten minutes, so it is asked for when it is wanted, and once more if it runs out. */
function Player({ callId, open, onFailed }) {
  const [rec, setRec] = useState(null);
  const [error, setError] = useState("");
  const retried = useRef(false);
  const audio = useRef();

  useEffect(() => {
    if (!open || rec) return;
    get(`/api/calls/${encodeURIComponent(callId)}/recording`)
      .then(setRec)
      .catch((e) => { setError(recordingMessage(e)); onFailed?.(); });
  }, [open, rec, callId, onFailed]);

  const expired = async () => {
    if (retried.current) { setError("The recording could not be played. Try again."); return; }
    retried.current = true;
    const at = audio.current?.currentTime || 0;
    try {
      setRec(await get(`/api/calls/${encodeURIComponent(callId)}/recording`));
      requestAnimationFrame(() => { if (audio.current) { audio.current.currentTime = at; audio.current.play().catch(() => {}); } });
    } catch (e) { setError(recordingMessage(e)); }
  };

  if (!open) return null;
  return (
    <motion.div className="rec-player" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <div className="rec-head"><Icon name="mic" /><b>Call recording</b></div>
      {!rec && !error && <span className="hint">Loading the recording…</span>}
      <AnimatePresence>
        {rec && (
          <motion.div key="audio" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="rec-audio">
            <audio ref={audio} controls autoPlay preload="none" src={rec.url} onError={expired} />
            <a className="btn ghost" href={rec.download_url} download><Icon name="download" />Download recording</a>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <div className="field-err" role="alert">{error}</div>}
    </motion.div>
  );
}

export default function CallDetail({ call, onClose }) {
  const [turns, setTurns] = useState(null);
  const [playing, setPlaying] = useState(false);
  const id = encodeURIComponent(call.call_id);
  useEffect(() => { get(`/api/calls/${id}/transcript`).then(setTurns).catch(() => setTurns([])); }, [id]);

  return (
    <Modal title={call.contact_name || call.peer || "Call"} onClose={onClose} wide>
      <div className="muted" style={{ marginBottom: "var(--s3)" }}>
        {[call.peer, whenShort(call.started_at), fmtDur(call.duration_secs), call.agent_name].filter(Boolean).join(" · ")}
      </div>

      <div className="call-actions">
        {call.has_recording && (
          <button type="button" className="primary" onClick={() => setPlaying(true)} disabled={playing}>
            <Icon name="play" />Play recording
          </button>
        )}
        <a className="btn ghost" href={`/api/calls/${id}/transcript.csv`} download title="Opens in Excel or Google Sheets"><Icon name="download" />Download transcript</a>
      </div>

      {call.has_recording && <Player callId={call.call_id} open={playing} onFailed={() => setPlaying(false)} />}
      <SavedAnswers callId={call.call_id} />

      <div className="chat" style={{ maxHeight: "50vh", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
        {!turns && <div className="hint">Loading…</div>}
        {turns && turns.length === 0 && <div className="hint">Nothing was said on this call.</div>}
        {turns?.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>{t.text}
            <time>{t.at ? new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</time></div>
        ))}
      </div>

    </Modal>
  );
}
