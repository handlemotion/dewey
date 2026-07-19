import type { DeweyDesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    dewey: DeweyDesktopApi;
  }
}
