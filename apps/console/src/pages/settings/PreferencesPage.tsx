import { useEffect, useState } from "react";
import { Group, Row } from "../../components/ui/Group";
import { readTheme, saveTheme, type Theme } from "../../theme";

export function PreferencesPage() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const choose = (next: Theme) => (saveTheme(next), setTheme(next));
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener("kairos:theme", sync);
    return () => window.removeEventListener("kairos:theme", sync);
  }, []);
  return (
    <>
      <h1>Preferences</h1>
      <Group title="Appearance">
        <div className="card rows">
          <Row title="Theme" note="Choose light or dark, or match your device.">
            <div className="seg">
              {(["system", "light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={theme === option ? "on" : ""}
                  onClick={() => choose(option)}
                  style={{ textTransform: "capitalize" }}
                >
                  {option}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </Group>
    </>
  );
}
