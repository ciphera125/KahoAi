// What every admin did, to whom, and when. Append-only: nothing here can be edited from the site.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, qs } from "../api.js";
import { serverView } from "../../../frontend/src/paginate.js";
import { Pager, Spinner, useToast } from "../../../frontend/src/ui.jsx";
import { Head } from "../parts.jsx";

const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

export default function Audit() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [d, setD] = useState(null);
  useEffect(() => { get(`/audit${qs({ page, per_page: size })}`).then(setD).catch((e) => toast(e.message, true)); }, [page, size, toast]);
  return (
    <section>
      <Head title="Admin record" sub="Every change an admin made, with who did it. It cannot be edited or deleted from here." />
      <div className="card list">
        {!d ? <Spinner /> : d.entries.length === 0 ? <div className="empty">Nothing recorded yet.</div> : (
          <div className="table-wrap"><table className="rows"><thead><tr><th>When (India)</th><th>Who</th><th>What</th><th>Organization</th></tr></thead>
            <tbody>{d.entries.map((e) => (
              <tr key={e.id}><td className="nowrap">{when(e.at)}</td><td>{e.admin_email}</td>
                <td><span className="code">{e.action}</span><div className="hint">{e.detail}</div></td>
                <td>{e.org_id ? <Link to={`/orgs/${e.org_id}`} className="code">{e.org_id}</Link> : "-"}</td></tr>))}</tbody></table></div>
        )}
      </div>
      {d && <Pager view={serverView({ page: d.page, total: d.total, size: d.per_page })} size={d.per_page} onPage={setPage} onSize={(x) => { setSize(x); setPage(1); }} />}
    </section>
  );
}
