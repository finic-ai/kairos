import { useEffect, useState } from "react";
import { Palette, type PaletteProps } from "../components/shell/Palette";

export function useShellChrome(route: string[], palette: Omit<PaletteProps, "onClose">) {
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route.join("/")]);
  useEffect(() => {
    document.querySelector(".frame-scroll")?.scrollTo(0, 0);
  }, [route.join("/")]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
        (event.preventDefault(), setSearching((open) => !open));
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return {
    menuOpen: menu,
    search: () => setSearching(true),
    menuButton: (
      <button
        type="button"
        className="menu-btn"
        aria-label="Open the menu"
        aria-expanded={menu}
        onClick={() => setMenu(true)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
        </svg>
      </button>
    ),
    backdrop: menu && <div className="menu-backdrop" onClick={() => setMenu(false)} aria-hidden="true" />,
    closeOnLink: (event: React.MouseEvent) => (event.target as HTMLElement).closest("a") && setMenu(false),
    palette: searching && <Palette {...palette} onClose={() => setSearching(false)} />,
  };
}
