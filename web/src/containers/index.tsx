import { ErrorFallback } from "../components/ErrorFallback";
import { Loading } from "../components/Loading";
import { Navbar } from "../components/Navbar";
import { pipe } from "../utility";
import { withBlank } from "../utility/withBlank";
import { withScrollRestoration } from "../utility/withScrollRestoration";
import { Suspense, lazy, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Route, Routes, useLocation } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const RoutesContainer = pipe(
  withBlank,
  withScrollRestoration
)(lazy(() => import("./Routes")));
const BuildContainer = withBlank(lazy(() => import("./Build")));
const OverlayContainer = lazy(() => import("./Overlay"));

export function App() {
  const location = useLocation();

  // Compact in-game overlay: no navbar, no page chrome.
  if (location.pathname === "/overlay")
    return (
      <Suspense fallback={null}>
        <ErrorBoundary FallbackComponent={ErrorFallback}>
          <Page title="Exile Leveling - Overlay" component={<OverlayContainer />} />
        </ErrorBoundary>
      </Suspense>
    );

  return (
    <>
      <Navbar />
      <Suspense fallback={<Loading />}>
        <ErrorBoundary FallbackComponent={ErrorFallback}>
          <Routes>
            <Route
              path="/"
              element={
                <Page title="Exile Leveling" component={<RoutesContainer />} />
              }
            />
            <Route
              path="/build"
              element={
                <Page
                  title="Exile Leveling - Build"
                  component={<BuildContainer />}
                />
              }
            />
          </Routes>
        </ErrorBoundary>
      </Suspense>
      <ToastContainer
        position="bottom-right"
        autoClose={2000}
        closeOnClick={true}
        theme={"dark"}
        pauseOnFocusLoss={false}
        pauseOnHover={false}
      />
    </>
  );
}

interface PageProps {
  title: string;
  component: JSX.Element;
}

function Page({ title, component }: PageProps) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return component;
}
