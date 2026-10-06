# Whim server

An individually owned server accepts Whim Notes, interprets them through replaceable providers, and carries out the owner's configured Workflow. Its language preserves Whim's capture and Delivery terms while naming server-side processing separately.

## Language

**Note**:
One finalized audio recording and its capture metadata, identified by an immutable Note ID.
_Avoid_: Voice memo, clip

**Delivery**:
Whim's logical requirement to submit a Note to its configured server destination. Successful Delivery establishes server acceptance, not completion of server-side processing.
_Avoid_: Processing, pipe execution

**Attempt**:
One device's HTTP request toward satisfying a Delivery. Several Attempts can refer to the same Note.
_Avoid_: Note, processing run

**Receipt**:
Evidence that an Attempt received a successful HTTP response from its destination.
_Avoid_: Processing result

**Workflow**:
The configured post-capture behavior assigned to a Note.
_Avoid_: Automation

**Step**:
One named behavior in a Workflow.
_Avoid_: Action

**Provider**:
A provisioned integration that supplies transcription, decisions, or extraction for a Workflow. These are independent roles, even when one vendor supplies several.
_Avoid_: Agent when referring only to a decision model

**Pipe**:
A provisioned capability that a Workflow may invoke, such as a destination webhook or configuration change.
_Avoid_: Provider, destination when including the configuration pipe

**Action**:
One invocation of a Pipe in a Note's execution plan, with stable identity, arguments, and an outcome.
_Avoid_: Attempt, Step

**Execution Plan**:
The validated, ordered set of Actions selected for one Note.
_Avoid_: Provider response, arbitrary script

**Request Recipe**:
The owner's definition of the HTTP request required by a destination Pipe.
_Avoid_: Agent-generated request

**Default Destination**:
A provisioned destination Pipe used when routing intent is unclear.
_Avoid_: Automatic provider fallback

**Server Configuration Revision**:
An immutable version of the server's processing settings and provisioned integration definitions. It is distinct from Whim's device-side Configuration Revision.
_Avoid_: Whim Configuration Revision, mutable snapshot

**Uncertain Outcome**:
An external Action that might have taken effect but lacks a known response, including interruption during its execution.
_Avoid_: Safe failure, successful completion

**Owner Resolution**:
An explicit owner decision about an uncertain or failed Action, such as marking it delivered or requesting another execution.
_Avoid_: Automatic retry
