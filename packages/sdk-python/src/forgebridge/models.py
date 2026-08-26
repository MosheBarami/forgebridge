"""ForgeBridge wire models, generated from the Zod contract.

DO NOT EDIT. Regenerate with `npm run generate:schemas` from the repository root;
`npm run verify:schemas` fails CI when this file and the schemas disagree.

Source of truth: packages/protocol/src/*.ts
Generator:       scripts/generate-schemas.ts

Every field name is the name on the wire. Where a wire name collides with a Python
keyword the attribute gains a trailing underscore and keeps the wire name as its
alias, so `model_dump(by_alias=True)` still produces the protocol's spelling.

Two things these models deliberately do not enforce; see
packages/protocol/schema/README.md for the full list:

* a ChangeSet's cross-operation ordering rule, which needs
  `forgebridge.checks.check_changeset_ordering`
* the UTF-8 *byte* bound on a script source, which is a UTF-16 code-unit bound here
"""

from typing import Annotated, Any, ClassVar, Literal

from annotated_types import Ge, Gt, Le, Len, Lt
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.functional_serializers import model_serializer

__all__ = ["ALL_MODELS"]


def _reject(forbidden: tuple[str, ...]):
    """Project a JSON Schema `not: {enum: [...]}` onto a string field."""

    def check(value: str) -> str:
        if value in forbidden:
            raise ValueError(f"{value!r} is not permitted here")
        return value

    return check


class _Model(BaseModel):
    # `extra="ignore"` mirrors Zod's default object mode, which strips unknown keys
    # rather than refusing them. A stricter setting here would refuse the
    # forward-compatible extra field the protocol's additive versioning promises.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    _omit_if_none: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_absent_optionals(self, handler):
        data = handler(self)
        for name in type(self)._omit_if_none:
            if name in data and data[name] is None:
                del data[name]
        return data


class OperationOutcome(_Model):
    index: Annotated[int, Ge(0)]
    ok: bool
    error: Annotated[str, StringConstraints(max_length=1000)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"error"})

class ApplyResult(_Model):
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    outcomes: list[OperationOutcome]
    newVersion: Annotated[int, Ge(0)]
    journalId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    appliedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    pluginVersion: Annotated[str, StringConstraints(max_length=40)]

ChangeSetStatus = Literal["draft", "proposed", "validated", "approved", "applying", "applied", "partial", "failed", "rejected", "stale"]

class ApplyResultAck(_Model):
    """Transcribed from ForgeBridgeDaemon#applyResult. Not generated from a Zod schema — the handler has none. TODO(M31)."""

    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    status: ChangeSetStatus
    version: Annotated[int, Ge(0)]
    journalId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]

class ApproveRequest(_Model):
    approvedBy: Annotated[str, StringConstraints(max_length=120)] = Field(default="local")
    note: Annotated[str, StringConstraints(max_length=500)] | None = Field(default=None)
    confirmBulkDelete: bool = Field(default=False)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"note"})

class ApproveResponse(_Model):
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    status: str
    nonce: Annotated[int, Ge(0)]

AttemptOutcome = Literal["ok", "rate-limited", "context-exceeded", "capability-missing", "provider-error", "timeout", "refused", "invalid-output", "cancelled"]

class BoolValue(_Model):
    t: Literal["Bool"]
    v: bool

class BrickColorValue(_Model):
    t: Literal["BrickColor"]
    name: Annotated[str, StringConstraints(min_length=1, max_length=64)]

class CFrameValue(_Model):
    t: Literal["CFrame"]
    position: tuple[float, float, float]
    rotation: tuple[float, float, float, float, float, float, float, float, float]

InstancePath = Annotated[str, StringConstraints(min_length=1, pattern=r'^(?:Workspace|ServerScriptService|ServerStorage|ReplicatedStorage|ReplicatedFirst|StarterGui|StarterPack|StarterPlayer|Lighting|SoundService|Teams|Chat|TextChatService)(?:\.[A-Za-z_][A-Za-z0-9_]{0,99}){0,31}$')]

ClassName = Annotated[str, StringConstraints(max_length=100, pattern=r'^[A-Za-z][A-Za-z0-9]*$')]

class StringValue(_Model):
    t: Literal["String"]
    v: Annotated[str, StringConstraints(max_length=200000)]

class NumberValue(_Model):
    t: Literal["Number"]
    v: float

class IntValue(_Model):
    t: Literal["Int"]
    v: int

class NilValue(_Model):
    t: Literal["Nil"]

class Vector3Value(_Model):
    t: Literal["Vector3"]
    x: float
    y: float
    z: float

class Vector2Value(_Model):
    t: Literal["Vector2"]
    x: float
    y: float

class Color3Value(_Model):
    t: Literal["Color3"]
    r: Annotated[float, Ge(0), Le(1)]
    g: Annotated[float, Ge(0), Le(1)]
    b: Annotated[float, Ge(0), Le(1)]

class UDimValue(_Model):
    t: Literal["UDim"]
    scale: float
    offset: int

class UDim2Value(_Model):
    t: Literal["UDim2"]
    xScale: float
    xOffset: int
    yScale: float
    yOffset: int

class RectValue(_Model):
    t: Literal["Rect"]
    minX: float
    minY: float
    maxX: float
    maxY: float

class EnumValue(_Model):
    t: Literal["Enum"]
    enum: Annotated[str, StringConstraints(pattern=r'^[A-Za-z][A-Za-z0-9]*$')]
    value: Annotated[str, StringConstraints(pattern=r'^[A-Za-z][A-Za-z0-9]*$')]

class InstanceRefValue(_Model):
    t: Literal["InstanceRef"]
    path: InstancePath

class ColorSequenceValueKeypointsItem(_Model):
    time: Annotated[float, Ge(0), Le(1)]
    r: Annotated[float, Ge(0), Le(1)]
    g: Annotated[float, Ge(0), Le(1)]
    b: Annotated[float, Ge(0), Le(1)]

class ColorSequenceValue(_Model):
    t: Literal["ColorSequence"]
    keypoints: Annotated[list[ColorSequenceValueKeypointsItem], Len(2, 20)]

class NumberSequenceValueKeypointsItem(_Model):
    time: Annotated[float, Ge(0), Le(1)]
    value: float
    envelope: float = Field(default=0)

class NumberSequenceValue(_Model):
    t: Literal["NumberSequence"]
    keypoints: Annotated[list[NumberSequenceValueKeypointsItem], Len(2, 20)]

class NumberRangeValue(_Model):
    t: Literal["NumberRange"]
    min: float
    max: float

class FontValue(_Model):
    t: Literal["Font"]
    family: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    weight: Annotated[str, StringConstraints(pattern=r'^[A-Za-z]+$')] = Field(default="Regular")
    style: Literal["Normal", "Italic"] = Field(default="Normal")

PropertyValue = Annotated[(StringValue | NumberValue | IntValue | BoolValue | NilValue | Vector3Value | Vector2Value | Color3Value | UDimValue | UDim2Value | RectValue | CFrameValue | BrickColorValue | EnumValue | InstanceRefValue | ColorSequenceValue | NumberSequenceValue | NumberRangeValue | FontValue), Field(discriminator="t")]

PropertyName = Annotated[str, StringConstraints(max_length=100, pattern=r'^[A-Za-z][A-Za-z0-9_]*$'), AfterValidator(_reject(("__index", "__newindex", "__metatable", "constructor", "prototype")))]

PropertyBag = dict[PropertyName, PropertyValue]

class CreateInstanceOp(_Model):
    op: Literal["createInstance"]
    path: InstancePath
    className: ClassName
    properties: PropertyBag = Field(default_factory=dict)

class SetPropertyOp(_Model):
    op: Literal["setProperty"]
    path: InstancePath
    property: Annotated[PropertyName, AfterValidator(_reject(("Parent", "Name")))]
    value: PropertyValue

ScriptType = Literal["Script", "LocalScript", "ModuleScript"]

class WriteScriptOp(_Model):
    op: Literal["writeScript"]
    path: InstancePath
    scriptType: ScriptType
    source: Annotated[str, StringConstraints(max_length=1048576)]

class MoveInstanceOp(_Model):
    op: Literal["moveInstance"]
    path: InstancePath
    to: InstancePath

class DeleteInstanceOp(_Model):
    op: Literal["deleteInstance"]
    path: InstancePath

Operation = Annotated[(CreateInstanceOp | SetPropertyOp | WriteScriptOp | MoveInstanceOp | DeleteInstanceOp), Field(discriminator="op")]

class Finding(_Model):
    severity: Literal["error", "warning", "info"]
    rule: Annotated[str, StringConstraints(pattern=r'^[a-z0-9-]+\/[a-z0-9-]+$')]
    message: Annotated[str, StringConstraints(max_length=2000)]
    operationIndex: Annotated[int, Ge(0)] | None = Field(default=None)
    line: Annotated[int, Ge(1)] | None = Field(default=None)
    column: Annotated[int, Ge(1)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"operationIndex", "line", "column"})

class ValidationLuau(_Model):
    status: Literal["ok", "warn", "fail"]
    findings: Annotated[list[Finding], Len(0, 1000)] = Field(default_factory=list)

class ValidationPolicy(_Model):
    status: Literal["ok", "fail"]
    violations: Annotated[list[Annotated[str, StringConstraints(max_length=500)]], Len(0, 200)] = Field(default_factory=list)

class Validation(_Model):
    luau: ValidationLuau
    policy: ValidationPolicy
    computedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    computedBy: Annotated[str, StringConstraints(max_length=120)]

class ChangeSet(_Model):
    id: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    runId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')] | None = Field(default=None)
    baseVersion: Annotated[int, Ge(0)]
    summary: Annotated[str, StringConstraints(min_length=1, max_length=300)]
    operations: Annotated[list[Operation], Len(1, 500)]
    validation: Validation | None = Field(default=None)
    status: ChangeSetStatus = Field(default="proposed")
    createdAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    metadata: dict[str, Any] = Field(default_factory=dict)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"runId", "validation"})

class ChangeSetDiffCounts(_Model):
    total: Annotated[int, Ge(0)]
    creates: Annotated[int, Ge(0)]
    setProperties: Annotated[int, Ge(0)]
    scripts: Annotated[int, Ge(0)]
    moves: Annotated[int, Ge(0)]
    deletes: Annotated[int, Ge(0)]

class OperationDiff(_Model):
    index: Annotated[int, Ge(0)]
    op: str
    paths: list[str]
    summary: str
    destructive: bool
    after: str | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"after"})

class ChangeSetDiff(_Model):
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    summary: str
    status: str
    baseVersion: Annotated[int, Ge(0)]
    currentVersion: Annotated[int, Ge(0)]
    stale: bool
    counts: ChangeSetDiffCounts
    operations: list[OperationDiff]
    validation: Validation | None = Field(default=None)
    treeAware: Literal[False]

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"validation"})

class DeliveryEnvelope(_Model):
    linkId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    nonce: Annotated[int, Ge(0)]
    mac: Annotated[str, StringConstraints(max_length=200)]
    payload: str
    encrypted: bool = Field(default=False)

class DeliveryPayloadChangeset(_Model):
    kind: Literal["changeset"]
    changeSet: ChangeSet

class DeliveryPayloadRollback(_Model):
    kind: Literal["rollback"]
    journalId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    expectedVersion: Annotated[int, Ge(0)]
    reason: Annotated[str, StringConstraints(max_length=500)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"reason"})

DeliveryPayload = Annotated[(DeliveryPayloadChangeset | DeliveryPayloadRollback), Field(discriminator="kind")]

ErrorCode = Literal["invalid_request", "stale_base", "not_approved", "policy_violation", "link_unpaired", "link_unauthenticated", "replay_detected", "too_large", "rate_limited", "budget_exhausted", "provider_unconfigured", "unsupported_version", "not_found", "internal"]

TransportKind = Literal["local-daemon", "relay-tls", "relay-e2e"]

class HealthResponse(_Model):
    ok: Literal[True]
    service: Literal["forgebridge-daemon"]
    version: str
    protocolVersion: str
    transport: TransportKind
    boundTo: str
    uptimeSeconds: Annotated[float, Ge(0)]

class InverseOperationDeleteCreated(_Model):
    inverse: Literal["deleteCreated"]
    path: str

class InverseOperationRestoreProperty(_Model):
    inverse: Literal["restoreProperty"]
    path: str
    property: str
    previous: Any

class InverseOperationRestoreSource(_Model):
    inverse: Literal["restoreSource"]
    path: str
    previousSource: str

class InverseOperationMoveBack(_Model):
    inverse: Literal["moveBack"]
    path: str
    from_: str = Field(alias="from")

class InverseOperationRestoreSubtree(_Model):
    inverse: Literal["restoreSubtree"]
    parentPath: str
    serialised: str

InverseOperation = Annotated[(InverseOperationDeleteCreated | InverseOperationRestoreProperty | InverseOperationRestoreSource | InverseOperationMoveBack | InverseOperationRestoreSubtree), Field(discriminator="inverse")]

class JournalEntryAppliedItem(_Model):
    index: Annotated[int, Ge(0)]
    operation: Operation

class JournalEntry(_Model):
    id: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    summary: Annotated[str, StringConstraints(max_length=300)]
    applied: list[JournalEntryAppliedItem]
    inverses: list[InverseOperation]
    versionBefore: Annotated[int, Ge(0)]
    versionAfter: Annotated[int, Ge(0)]
    appliedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    rolledBackAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')] | None = Field(default=None)

LinkState = Literal["unpaired", "pairing", "paired", "expired", "revoked"]

class Link(_Model):
    id: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    transport: TransportKind
    state: LinkState
    sessionKeyId: Annotated[str, StringConstraints(max_length=64)] | None = Field(default=None)
    pluginVersion: Annotated[str, StringConstraints(max_length=40)] | None = Field(default=None)
    studioVersion: Annotated[str, StringConstraints(max_length=40)] | None = Field(default=None)
    placeId: int | None = Field(default=None)
    lastSeenAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')] | None = Field(default=None)
    createdAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]

class LinkStatusResponse(_Model):
    transport: TransportKind
    privacyPosture: str
    protocolVersion: str
    defaultProjectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    links: list[Link]
    pairing: dict[str, Any] | None

class ModelAttempt(_Model):
    modelId: Annotated[str, StringConstraints(max_length=200)]
    providerSlug: Annotated[str, StringConstraints(max_length=80)] | None = Field(default=None)
    outcome: AttemptOutcome
    startedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    durationMs: Annotated[int, Ge(0)]
    promptTokens: Annotated[int, Ge(0)] | None = Field(default=None)
    completionTokens: Annotated[int, Ge(0)] | None = Field(default=None)
    costUsd: Annotated[float, Ge(0)] | None = Field(default=None)
    note: Annotated[str, StringConstraints(max_length=500)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"providerSlug", "promptTokens", "completionTokens", "costUsd", "note"})

class ModelsSnapshot(_Model):
    configured: bool
    source: Annotated[str, StringConstraints(max_length=200)]
    verifiedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')] | None
    models: list[dict[str, Any]]

OutputLevel = Literal["print", "info", "warning", "error"]

class OutputMessage(_Model):
    level: OutputLevel
    message: Annotated[str, StringConstraints(max_length=10000)]
    at: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    source: Annotated[str, StringConstraints(max_length=200)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"source"})

class OutputBatch(_Model):
    messages: Annotated[list[OutputMessage], Len(1, 200)]

class OutputResponse(_Model):
    messages: list[OutputMessage]

PairingCode = Annotated[str, StringConstraints(min_length=8, max_length=8, pattern=r'^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$')]

class PairRequest(_Model):
    pairingCode: PairingCode
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')] | None = Field(default=None)
    pluginVersion: Annotated[str, StringConstraints(max_length=40)] | None = Field(default=None)
    studioVersion: Annotated[str, StringConstraints(max_length=40)] | None = Field(default=None)
    placeId: int | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"projectId", "pluginVersion", "studioVersion", "placeId"})

class PairResponse(_Model):
    linkId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    sessionKeyId: Annotated[str, StringConstraints(max_length=64)]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    transport: TransportKind
    privacyPosture: str
    sessionSalt: str
    since: Annotated[int, Ge(0)]
    protocolVersion: str

class ProtocolError(_Model):
    code: ErrorCode
    message: Annotated[str, StringConstraints(max_length=500)]
    remedy: Annotated[str, StringConstraints(max_length=500)] | None = Field(default=None)
    traceId: Annotated[str, StringConstraints(max_length=64)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"remedy", "traceId"})

class RollbackRequest(_Model):
    journalId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    expectedVersion: Annotated[int, Ge(0)]
    reason: Annotated[str, StringConstraints(max_length=500)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"reason"})

class RollbackResponse(_Model):
    journalId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    status: Literal["dispatched"]
    nonce: Annotated[int, Ge(0)]

RunStage = Literal["queued", "planning", "generating", "validating", "awaiting-approval", "applying", "testing", "done", "failed", "cancelled"]

RunStatus = Literal["running", "succeeded", "failed", "cancelled"]

class RunProducer(_Model):
    kind: Literal["web", "mcp", "a2a", "cli", "sdk", "rest"]
    client: Annotated[str, StringConstraints(max_length=120)] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"client"})

class Run(_Model):
    id: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    projectId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    prompt: Annotated[str, StringConstraints(min_length=1, max_length=50000)]
    stage: RunStage = Field(default="queued")
    status: RunStatus = Field(default="running")
    attempts: list[ModelAttempt] = Field(default_factory=list)
    changeSetIds: list[Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]] = Field(default_factory=list)
    producer: RunProducer | None = Field(default=None)
    startedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')]
    finishedAt: Annotated[str, StringConstraints(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')] | None = Field(default=None)

    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the
    # parsed object entirely, and a projection that emitted `null` instead would not
    # round-trip.
    _omit_if_none: ClassVar[frozenset[str]] = frozenset({"producer"})

class SubmitChangeSetResponse(_Model):
    """Transcribed from ForgeBridgeDaemon#submitChangeSet. Not generated from a Zod schema — the handler has none. TODO(M31)."""

    changeSetId: Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    status: ChangeSetStatus
    baseVersion: Annotated[int, Ge(0)]
    validation: Validation


#: Every wire type this module projects, by its protocol name.
ALL_MODELS: dict[str, Any] = {
    "ApplyResult": ApplyResult,
    "ApplyResultAck": ApplyResultAck,
    "ApproveRequest": ApproveRequest,
    "ApproveResponse": ApproveResponse,
    "AttemptOutcome": AttemptOutcome,
    "BoolValue": BoolValue,
    "BrickColorValue": BrickColorValue,
    "CFrameValue": CFrameValue,
    "ChangeSet": ChangeSet,
    "ChangeSetDiff": ChangeSetDiff,
    "ChangeSetStatus": ChangeSetStatus,
    "ClassName": ClassName,
    "Color3Value": Color3Value,
    "ColorSequenceValue": ColorSequenceValue,
    "CreateInstanceOp": CreateInstanceOp,
    "DeleteInstanceOp": DeleteInstanceOp,
    "DeliveryEnvelope": DeliveryEnvelope,
    "DeliveryPayload": DeliveryPayload,
    "EnumValue": EnumValue,
    "ErrorCode": ErrorCode,
    "Finding": Finding,
    "FontValue": FontValue,
    "HealthResponse": HealthResponse,
    "InstancePath": InstancePath,
    "InstanceRefValue": InstanceRefValue,
    "IntValue": IntValue,
    "InverseOperation": InverseOperation,
    "JournalEntry": JournalEntry,
    "Link": Link,
    "LinkState": LinkState,
    "LinkStatusResponse": LinkStatusResponse,
    "ModelAttempt": ModelAttempt,
    "ModelsSnapshot": ModelsSnapshot,
    "MoveInstanceOp": MoveInstanceOp,
    "NilValue": NilValue,
    "NumberRangeValue": NumberRangeValue,
    "NumberSequenceValue": NumberSequenceValue,
    "NumberValue": NumberValue,
    "Operation": Operation,
    "OperationDiff": OperationDiff,
    "OperationOutcome": OperationOutcome,
    "OutputBatch": OutputBatch,
    "OutputLevel": OutputLevel,
    "OutputMessage": OutputMessage,
    "OutputResponse": OutputResponse,
    "PairRequest": PairRequest,
    "PairResponse": PairResponse,
    "PairingCode": PairingCode,
    "PropertyBag": PropertyBag,
    "PropertyName": PropertyName,
    "PropertyValue": PropertyValue,
    "ProtocolError": ProtocolError,
    "RectValue": RectValue,
    "RollbackRequest": RollbackRequest,
    "RollbackResponse": RollbackResponse,
    "Run": Run,
    "RunStage": RunStage,
    "RunStatus": RunStatus,
    "ScriptType": ScriptType,
    "SetPropertyOp": SetPropertyOp,
    "StringValue": StringValue,
    "SubmitChangeSetResponse": SubmitChangeSetResponse,
    "TransportKind": TransportKind,
    "UDim2Value": UDim2Value,
    "UDimValue": UDimValue,
    "Validation": Validation,
    "Vector2Value": Vector2Value,
    "Vector3Value": Vector3Value,
    "WriteScriptOp": WriteScriptOp,
}
