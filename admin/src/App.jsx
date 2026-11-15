// Real URLs, one per screen. Signed out, every path shows the admin sign-in; "/" goes to the overview.
import { Navigate, Route, Routes } from "react-router-dom";
import { Spinner } from "../../frontend/src/ui.jsx";
import { useAdmin } from "./auth.jsx";
import Layout from "./Layout.jsx";
import SignIn from "./pages/SignIn.jsx";
import Overview from "./pages/Overview.jsx";
import Orgs from "./pages/Orgs.jsx";
import OrgDetail from "./pages/OrgDetail.jsx";
import People from "./pages/People.jsx";
import Requests from "./pages/Requests.jsx";
import Topups from "./pages/Topups.jsx";
import Plans from "./pages/Plans.jsx";
import Audit from "./pages/Audit.jsx";
import System from "./pages/System.jsx";

export default function App() {
  const { admin } = useAdmin();
  if (admin === undefined) return <Spinner />;
  if (!admin) return <SignIn />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/overview" element={<Overview />} />
        <Route path="/orgs" element={<Orgs />} />
        <Route path="/orgs/:orgId" element={<OrgDetail />} />
        <Route path="/people" element={<People />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/topups" element={<Topups />} />
        <Route path="/plans" element={<Plans />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/system" element={<System />} />
      </Route>
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
