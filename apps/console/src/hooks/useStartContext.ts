import { useOutletContext } from "react-router";

export interface StartContext {
  /** False until every step is checked: until then the first page is not known. */
  checked: boolean;
  shown: boolean;
  hidden: boolean;
  onShow: () => void;
}

export const useStartContext = () => useOutletContext<StartContext>();
