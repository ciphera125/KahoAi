import { useEffect } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { Footer } from "./footer/Footer";
import { Home } from "./pages/Home";
import { Features } from "./pages/Features";
import { BookACall } from "./pages/BookACall";
import { ComingSoon, NotFound } from "./pages/Simple";
import { metaFor } from "./content/seo";
import { SITE_URL } from "./config";

function setMeta(selector: string, attr: string, value: string) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

/** Keep title, description, canonical and Open Graph in step with the route. */
function useRouteMeta() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const m = metaFor(pathname);
    document.title = m.title;
    setMeta('meta[name="description"]', "content", m.description);
    setMeta('meta[property="og:title"]', "content", m.title);
    setMeta('meta[property="og:description"]', "content", m.description);
    setMeta('meta[property="og:url"]', "content", SITE_URL + m.path);
    setMeta('link[rel="canonical"]', "href", SITE_URL + m.path);
  }, [pathname]);
  // New page: start at the top, unless a #section was asked for.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
}

function Layout() {
  useRouteMeta();
  return (
    <>
      <a className="k-skip" href="#main">Skip to content</a>
      <Header />
      <main id="main" className="k-main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="features" element={<Features />} />
        <Route path="book-a-call" element={<BookACall />} />
        <Route path="privacy" element={<ComingSoon title="Privacy policy" />} />
        <Route path="terms" element={<ComingSoon title="Terms" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
