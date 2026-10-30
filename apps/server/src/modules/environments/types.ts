export interface Environment {
  id: string;
  workspace_id: string;
  name: string;
  kind: "production" | "sandbox";
  created: string;
}
