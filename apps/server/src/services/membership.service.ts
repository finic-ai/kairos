import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

export class MembershipsService extends DatabaseService<"memberships"> {
  constructor(db: Executor, scope: { workspaceId: string }) {
    super(db, "memberships", scope);
  }

  /** Active only when both the membership and its workspace are. */
  async findByUser(userId: string) {
    const found = await this.findFirst({
      where: { userId },
      columns: { role: true, status: true },
      with: { workspace: { columns: { status: true } } },
    });
    return found
      ? { role: found.role, active: found.status === "active" && found.workspace.status === "active" }
      : null;
  }

  listWithUsers() {
    return this.findMany({
      columns: { role: true, status: true, created: true },
      // Not the whole user: only UsersService reads how a person signs in.
      with: {
        user: { columns: { id: true, email: true, firstName: true, lastName: true, displayName: true, created: true } },
      },
      orderBy: { created: "asc", seq: "asc" },
    });
  }

  countActiveOwners(): Promise<number> {
    return this.count({ role: "owner", status: "active" });
  }
}
