// Real URLs, one per screen: /dashboard, /calls, /contacts, /bulk, /agents,
// /agents/:id, /prompts, /numbers, /team. Each loads on its own. Signed out,
// every path shows the sign-in screen; "/" sends you to the dashboard.
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import { Spinner } from "./ui.jsx";
import Layout from "./components/Layout.jsx";
import SignIn from "./pages/SignIn.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Calls from "./pages/Calls.jsx";
import Contacts from "./pages/Contacts.jsx";
import Agents from "./pages/Agents.jsx";
import AgentDetail from "./pages/AgentDetail.jsx";
import Prompts from "./pages/Prompts.jsx";
import Numbers from "./pages/Numbers.jsx";
import Team from "./pages/Team.jsx";
import Bulk from "./pages/Bulk.jsx";
import ToolCalls from "./pages/ToolCalls.jsx";
import Tags from "./pages/Tags.jsx";
import ErrorLogs from "./pages/ErrorLogs.jsx";
import Settings from "./pages/Settings.jsx";
import Live from "./pages/Live.jsx";

export default function App() {
  const { me } = useAuth();
  if (me === undefined) return <Spinner />;
  if (!me) return <SignIn />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/bulk" element={<Bulk />} />
        <Route path="/bulk/:runId" element={<Bulk />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/:agentId" element={<AgentDetail />} />
        <Route path="/prompts" element={<Prompts />} />
        <Route path="/numbers" element={<Numbers />} />
        <Route path="/team" element={<Team />} />
        <Route path="/tool-calls" element={<ToolCalls />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/errors" element={<ErrorLogs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/live" element={<Live />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
