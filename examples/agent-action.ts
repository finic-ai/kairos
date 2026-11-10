/** The entity types and the questions about AI agents that the agent examples share. */
import type { ActionDefinition, Kairos } from "../packages/sdk/src/index.js";

export async function defineAgentEntities(kairos: Kairos) {
  await kairos.defineEntity("agent", { kind: "other", description: "An AI agent that runs tasks and calls tools" });
  // Many agents serve the same customers and tickets; that does not make two agents related.
  await kairos.defineEntity("customer", { kind: "person", link: false });
  await kairos.defineEntity("ticket", { kind: "document", link: false });
}

export const agentTypologies = {
  legit: "The call is part of the agent's ordinary work on the task of this run",
  prompt_injection: "The agent follows instructions that came from content it read, not from its task",
  privilege_escalation: "The agent reaches for tools or access that it does not use in its work",
  data_exfiltration: "The agent collects data and sends it to a place outside the company",
  data_leak: "The agent shows one customer's data to another customer",
  misused_authority:
    "The agent uses a power it has, such as a refund, far beyond its usual use or for the wrong person",
  runaway: "The agent repeats itself or spends far more than usual, without progress on the task",
};

export const agentReasons = {
  tool_never_used:
    "The agent has not called this tool in its history, and nothing about the agent says it was given it",
  outside_task_scope: "The call has no connection to the task the run was given",
  instruction_from_content:
    "Shortly before, the agent read outside content (an email, a web page, a file) that contains instructions",
  external_destination: "The call sends data to an address or a host outside the company",
  bulk_data_access: "The run reads records of many customers that are not part of its task",
  other_customer_data: "The call reads or sends data of a customer that the ticket is not about",
  repeated_calls: "The run calls the same tool with the same arguments many times",
  token_spend_above_usual: "The model tokens of the run are far above what this agent usually spends",
  amount_above_usual: "A money amount in the call is far above what this agent usually moves",
};

/** `trigger`: the tool event to decide on. `hold`: the question, which says when the call is asked. */
export function agentAction(trigger: string, hold: string, extra: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    subject: "agent",
    trigger,
    hold,
    typologies: agentTypologies,
    reasons: agentReasons,
    policy: {
      block: 0.9,
      review: 0.5,
      rules: [
        { id: "injected_egress", allOf: ["instruction_from_content", "external_destination"], outcome: "block" },
        {
          id: "token_burn",
          allOf: ["token_spend_above_usual"],
          when: [{ total: "tokens", is: "times_usual", op: ">", value: 10 }],
          outcome: "review",
        },
      ],
    },
    context: {
      recentEvents: 60,
      // The example agents run once every eight hours, so an 8h window holds about one usual run.
      totals: [{ name: "tokens", event: "llm_call", sum: "tokens", window: "8h", usual: "14d" }],
    },
    ...extra,
  };
}

export const BEHAVIOR =
  "the agent no longer behaves like itself: it does something outside the task of the run, follows instructions " +
  "that came from content it read, moves data out or to the wrong person, misuses a power it has, or runs out of control";
