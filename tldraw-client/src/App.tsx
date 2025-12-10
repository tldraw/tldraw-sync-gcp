import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from "react-router-dom";
import { Room } from "./Room";
import { uniqueId } from "tldraw";

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
    element: <Room />,
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
