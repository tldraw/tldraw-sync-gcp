import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from "react-router-dom";
import { Room } from "./Room";
import { uniqueId } from "tldraw";
import { ErrorBoundary } from "./components/ErrorBoundary";

function Root() {
  const randomId = uniqueId();
  return <Navigate to={`/${randomId}`} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
  },
  {
    path: "/:roomId",
    element: (
      <ErrorBoundary>
        <Room />
      </ErrorBoundary>
    ),
  },
  {
    path: "*",
    element: <div style={{ padding: 20 }}>404: Page Not Found</div>,
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
