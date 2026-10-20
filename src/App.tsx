import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard }      from "./pages/Dashboard";
import { CreateBudget }   from "./pages/CreateBudget";
import { Playground }     from "./pages/Playground";
import { PaymentHistory } from "./pages/PaymentHistory";
import { ManageSession }  from "./pages/ManageSession";
import Integrations       from "./pages/Integrations";

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/"              element={<Dashboard />}      />
          <Route path="/create"        element={<CreateBudget />}   />
          <Route path="/playground"    element={<Playground />}     />
          <Route path="/payments"      element={<PaymentHistory />} />
          <Route path="/sessions/:id"  element={<ManageSession />}  />
          <Route path="/integrations"  element={<Integrations />}   />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
