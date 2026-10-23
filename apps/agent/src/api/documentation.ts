import { agentContractDocument, agentContractOperations } from '@tyde/shared/agent';
import type { FastifyInstance, FastifySchema } from 'fastify';

type Json = Record<string, unknown>;
const labels: Record<string, string> = {
  tool_execution: '工具调用的完整安全投影；不属于业务操作或正式核验',
  result_summary: '工具成功结果的安全摘要；未成功时为 null',
  result_ref: '工具原生结果的不透明 UUID 引用；未成功时为 null，不是 URL 或文件路径',
  tool_executions: '本次读取覆盖任务的全部工具安全投影；新运行始终返回数组，旧冻结数据可省略',
  schema_version: '公开载荷版本，固定为 1',
  request_id: '本次 HTTP 请求的 UUID 关联号',
  request_key: '原请求幂等 UUID，同一意图重发必须保持原值',
  client_instance_id: '可选客户端实例 UUID，只作关联，不授予权限',
  conversation_id: '所属会话 UUID',
  task_id: '所属任务 UUID',
  attempt_id: '所属执行尝试 UUID',
  target_attempt_id: '明确指定的停止或恢复目标尝试 UUID',
  expected_task_version: '用户决定动作时观察到的任务版本，十进制字符串',
  id: '对象 UUID',
  title:
    '会话标题，1 至 80 个 Unicode 码点；创建时省略则先显示“新会话”，首条受理用户输入会折叠空白并取前 80 个码点作为预览；显式标题保留，不额外调用模型',
  text: '文字正文，按普通文本或安全 Markdown 展示',
  blocks: '文字块列表，空数组含义由消息类型决定',
  context: '随原输入固定的业务定位信息；不授予会话或业务权限',
  row_version: '对象行版本，十进制字符串，仅用于同类对象比较',
  created_at: '创建时间，RFC 3339 UTC 时间',
  updated_at: '最近更新时间，RFC 3339 UTC 时间',
  last_activity_at: '最近活动时间，RFC 3339 UTC 时间',
  last_message_seq: '当前消息最大序号，十进制字符串',
  stream_id: '会话事件流 UUID；PostgreSQL 模式跨重启保留，内存模式重启失效',
  event_seq: '可靠事件水位，非负十进制字符串',
  after_seq: '客户端已成功应用的可靠事件水位，补读严格大于此值',
  upper_message_seq: '快照固定的消息成员上界，非负十进制字符串',
  before_message_seq: '可选历史分页上界，仅返回序号严格小于它的消息',
  next_before_message_seq: '更早一页上界；null 表示没有更早消息',
  message_seq: '稳定消息序号，正十进制字符串',
  message_limit: '快照尾页条数，默认 50，范围 1 至 100',
  limit: '分页条数，列表默认 20、历史默认 50，范围 1 至 100',
  cursor: '可选签名分页游标，最多 2048 字符；不是访问凭证',
  next_cursor: '下一页签名游标；null 表示本次已到末页',
  has_more: '是否存在更早或后续页面',
  started_at: '尝试开始时间；未开始时为 null',
  ended_at: '尝试实际结束时间；未结束时为 null',
  stop_requested_at: '用户停止受理时间；未请求停止时为 null',
  execution_deadline_at: '本尝试执行截止 UTC 时间；未开始时为 null',
  max_duration_ms: '累计执行时长上限，单位毫秒，默认 600000',
  max_model_requests: '模型发送授权上限，默认 12，失败不退次数',
  max_tool_calls: '工具执行授权上限，默认 10，失败不退次数',
  model_requests_used: '实际已预占的模型发送授权数；不等于 token 或计费次数',
  tool_calls_used: '实际已预占的工具执行授权数；不等于成功工具数',
  policy_version: '预算计数和终止规则版本，当前为 1',
  limit_exceeded_kind: '首次锁存的预算限制；null 表示尚未触发',
  limit_exceeded_at: '首次预算限制锁存 UTC 时间；未触发时为 null',
  budget: '本尝试真实累计预算；历史未跟踪时可缺省或为 null，新尝试始终返回真实视图',
  input_state: '输入消费状态，用户消息展示完成不代表已消费',
  input_attempt_id: '实际消费或处理该输入的尝试 UUID；pending 时为 null',
  handling_summary: '输入处理的脱敏摘要；尚未处理时为 null',
  message_type: '消息类型',
  content: '消息公开内容，不含 Pi 原生记录或凭据',
  content_schema_version: '消息内容版本，当前为 1',
  payload_schema_version: '结果载荷版本，当前为 1',
  business_scope: '已确认的任务业务范围；本轮仅普通问答，不执行业务写入',
  scope_locked_at: '业务范围锁定 UTC 时间；未锁定时为 null',
  result_id: '最终交付结果 UUID；未交付时为 null',
  result_attempt_id: '原命令明确裁决的尝试 UUID；没有可关联尝试时为 null',
  active_attempt_id: '当前有效尝试 UUID；结束后为 null',
  previous_attempt_id: '前一尝试 UUID；首次为 null',
  attempt_no: '任务内从 1 开始的尝试编号',
  output_stream_id: '单个输出流 UUID，不同值不可拼接；重连中途加入时丢弃不完整临时片段',
  delta_index: '输出流内连续增量索引，从 1 开始；缺口必须重新取快照',
  delta: '临时文字增量，不推进可靠事件游标',
  data: '接口成功数据；失败时为 null',
  error: '脱敏错误；成功时为 null',
  replayed: '是否原 key 同意图重放；冻结裁决不随任务现状改变',
  command: '冻结的原命令记录；协议或访问错误时为 null',
  decision: '原命令冻结裁决；未确认时为 null',
  receipt: '原命令冻结 HTTP 裁决，不是当前任务状态',
  http_status: '原命令 HTTP 状态码',
  read_cursor: '本次一致读取观察到的事件水位，不代表客户端已应用',
  event_pruned_through_seq: '已裁剪的事件前缀水位，非负十进制字符串',
  action: '建议客户端采取的下一步动作；不是执行授权，也不能据此自动创建新意图',
  action_key: '同一任务内业务动作链的稳定标识，本轮尚无业务工具',
  action_version: '业务动作链从 1 开始的版本，本轮尚无业务工具',
  business_service: '提供核验事实的业务服务标识；本轮普通问答不声明业务事实来源',
  code: '机器可读的脱敏错误码或控制码，中文含义随具体取值说明',
  completed_at: '任务成功交付的 UTC 时间；任务未完成时为 null，不表示尝试结束时间',
  confirmation_state: '业务操作可信效果的核实状态；模型自称成功不作为核实依据，本轮未开放',
  data_as_of: '核验所依据业务数据的 UTC 时间；普通问答或数据时间未知时为 null',
  department_id: '本次输入明确保留的业务部门标识，1 至 128 字符，不授予业务或会话权限',
  draft_id: '业务后端确认的排班草案标识；本轮不生成业务草案',
  end: '包含在范围内的结束日期，YYYY-MM-DD；不得早于开始日期',
  event_type: '可靠产品事件类型，决定 payload 的结构；不是 Pi 或模型原始事件',
  fields: '可安全展示的字段校验问题；空数组表示没有逐字段诊断',
  focus_task: '当前未完成目标；没有未完成目标时为最近任务，没有任务时为 null',
  frame_kind: '事件帧类别；只有 product 成功按序应用后可推进可靠游标',
  goal_text: '创建该任务时保留的原始目标正文；后续查询不会用模型回答改写目标',
  input_receipt: '本条用户输入对应的消费回执；非用户消息或没有新输入时为 null',
  input_receipts: '本页消息及焦点任务所覆盖的输入消费回执；空数组表示本次读取没有相关输入',
  input_state_at_decision:
    '原命令裁决时的新输入状态；none 表示本命令没有新输入，pending 表示已安排但未消费',
  items: '按最近活动时间和会话 UUID 倒序排列的当前用户私有会话；空数组表示本页没有会话',
  kind: '用户命令类型，决定请求字段及状态前置条件；未实现类型会明确拒绝',
  label: '核验数据来源的可读名称；只说明已取得的来源，不代表模型推断已获业务确认',
  latest_attempt: '该任务最近一次执行尝试；其预算和结局与本条任务版本一起读取',
  message: '可展示的错误文字，或事件中的完整产品消息；具体结构由当前 Schema 决定',
  messages: '本页消息，按 message_seq 升序排列；包含完整记录，不依赖临时流式片段恢复',
  object_type: '业务交付对象类型；schedule_draft 表示排班草案，本轮未开放',
  occurred_at: '产品事件在服务端冻结的 UTC 时间；事件顺序仍以 event_seq 为准',
  operation_kind: '受控业务操作类型；本轮没有业务写工具或操作记录',
  operations: '本次消息或结果覆盖的业务操作摘要；本轮固定为空数组，不伪造工具执行',
  outcome: '本次尝试的最终结局；执行或停止收尾尚未结束时为 null',
  outcome_code: '冻结的原命令裁决码；不表示查询时任务的最新状态',
  path: '校验失败字段的 JSON 路径，指向原请求；不包含正文或凭据',
  pinned_messages: '快照尾页之外仍未结束的消息，用于保留流式目标；与 messages 按消息 ID 合并去重',
  previous_operation_id: '同一业务动作链的直接前序操作 UUID；没有前序时为 null，本轮未开放',
  processed_at: '原命令裁决冻结的 UTC 时间；同 key 重放不会更新此时间',
  reason: '字段不合法的中文原因，或要求重建订阅的机器原因；不包含敏感输入',
  result: '任务或查询指定的不可变交付结果；任务尚未成功交付时为 null',
  result_attempt_outcome_at_decision: '原命令裁决所安排尝试当时的结局；未结束或未安排尝试时为 null',
  result_type: '交付结果的结构类型；本轮只返回 answer 文字回答',
  results: '本页消息及焦点任务引用的不可变交付结果；空数组表示本次读取没有已交付结果',
  retry_after_ms: '服务建议重新订阅前等待的毫秒数；等待不会启动、重试或停止任务',
  selected_employee_ids:
    '本次输入明确保留的业务员工标识列表，1 至 100 项且不重复；只定位范围，不授予权限',
  source_command_id: '创建用户输入消息的原命令 UUID；助手或提示消息为 null',
  sources: '实际核验过的业务数据来源；本轮普通问答为空数组，不声明模型文字具有业务核验来源',
  start: '包含在范围内的开始日期，YYYY-MM-DD；必须是真实日历日期',
  start_reason: '本次尝试的创建原因；本轮只创建 initial，补充、继续和重试尚未开放',
  status: '当前对象的状态；命令状态为冻结裁决，任务和消息状态随版本推进',
  summary: '允许展示的脱敏错误、操作或结果摘要；不含堆栈、凭据或完整工具参数',
  task_kind: '服务端认可的任务类型；本轮仅开放 business_query 普通问答',
  task_status_at_decision: '原命令冻结裁决时观察到的任务状态；不是当前执行进度，没有目标时为 null',
  task_version_at_decision: '原命令冻结裁决时的任务版本，非负十进制字符串；没有目标时为 null',
  type: '内容块类型；text 表示普通文本或安全 Markdown，不执行原始 HTML',
  user_message_id: '本命令新增用户输入消息的 UUID；停止或没有新增输入时为 null',
  verified_at: '服务端接受本次交付的 UTC 时间；普通问答仅确认执行完整结束，不冒充业务事实核验',
  version: '业务后端确认的交付对象版本；未知时为 null，本轮未生成此类对象',
};

const schemaDescriptions: Record<string, string> = {
  TaskStatus: '任务当前生命周期状态；停止受理、实际停止、失败与成功交付分别表达。',
  AttemptOutcome: '一次执行尝试的最终结局；任务继续或重试不会改写旧尝试结局。',
  CommandKind: '用户明确提交的产品命令类别；本轮只支持新目标与停止指定尝试。',
  ErrorField: '单个字段校验问题，仅包含请求路径和可展示原因。',
  AppliedCommand: '已应用的原命令记录，冻结原裁决供同 key 重放及核实。',
  RejectedCommand: '已记录的原命令拒绝，冻结拒绝原因，不表示服务端未收到该命令。',
  RejectedError: '已记录命令拒绝的脱敏原因；与原命令一起冻结，不用当前状态替换。',
  ConversationView: '当前用户私有会话的公开元数据；不暴露 Pi 会话、原生状态或模型凭据。',
  AttemptView: '任务最近一次执行尝试的公开状态、时间和真实累计预算。',
  NonCompletedTaskView: '尚未成功交付的任务投影；停止、失败和待补充仍保留原目标。',
  CompletedTaskView: '已成功交付的任务投影，与最终尝试和不可变结果保持关联。',
  TextBlock: '供界面安全展示的非空文字内容块，不包含可执行 HTML。',
  MessageContent: '消息文字块及原输入保留的业务上下文；最终回答正文通过关联结果读取。',
  PendingInputReceipt: '已安排但尚未由 Pi 消费的用户输入回执；不因用户消息已展示就视为消费。',
  ConsumedInputReceipt: '已由指定尝试消费的用户输入回执，保留原命令和消息关联。',
  HandledInputReceipt: '已明确处理但未作为常规输入消费的回执，提供可展示处理原因。',
  VerificationSource: '实际取得并用于核验的业务事实来源；普通聊天不伪造此类来源。',
  AnswerPayload: '最终文字回答正文；仅在模型合法完整结束且交付门禁通过后生成。',
  SchedulingDraftPayload: '业务后端确认的排班草案交付引用，本轮尚未实现。',
  AnswerResultView: '不可变的最终文字回答，关联唯一任务和交付尝试。',
  SchedulingDraftResultView: '不可变的业务草案交付引用，本轮尚未实现。',
  CreateConversationData: '新建空会话的元数据和一致读取水位；创建本身不启动执行。',
  ConversationListItem: '一个私有会话及同次观察到的事件水位，用于列表展示。',
  ConversationDetailData: '会话概况、焦点任务与同次一致读取水位；读取不启动执行。',
  TaskDetailData: '指定任务的当前投影、已交付结果和相关操作摘要。',
  ResultDetailData: '指定不可变交付结果及其关联的业务操作摘要。',
  Applied202Receipt: '原命令已受理的冻结 HTTP 202 回执；不表示模型已运行或停止已完成。',
  Applied200Receipt: '原命令已明确裁决的冻结 HTTP 200 回执；本轮用于重复停止和目标已结束。',
  RejectedCommandReceipt: '原命令已记录拒绝的冻结 HTTP 409 回执，可按原 key 核实。',
  CommandLookupData: '按原 request_key 核实的冻结裁决、当前输入消费回执及一致读取水位。',
  ReadErrorDetails: '只读请求的可展示诊断字段和服务端水位；缺少字段表示没有该项诊断。',
  ReadError: '读取或空会话创建失败的脱敏诊断和下一步建议，不包含凭据或内部堆栈。',
  ReadErrorResponse: '读取或空会话创建失败的响应包装；data 为 null，保留请求关联号。',
  CreateConversationResponse: '空会话创建成功响应；非幂等请求，响应丢失后应先核对会话列表。',
  ConversationListResponse: '当前用户私有会话分页成功响应，不包含其他用户会话。',
  ConversationDetailResponse: '会话概况的一致读取成功响应。',
  SnapshotResponse: '完整展示快照和水位的成功响应；全部应用后才订阅水位之后的事件。',
  TaskDetailResponse: '指定任务当前状态的一致读取成功响应。',
  MessageHistoryResponse: '固定消息成员上界内的历史分页响应；读取不推进可靠事件游标。',
  ResultDetailResponse: '指定不可变交付结果的一致读取成功响应。',
  CommandLookupResponse: '核实原命令冻结裁决的只读成功响应；不会重新派发原命令。',
  ConversationUpdatedPayload: '会话元数据变化事件冻结的完整会话投影。',
  TaskUpdatedPayload: '任务、尝试或预算变化事件冻结的完整任务投影。',
  TaskCompletedPayload: '一次交付原子冻结的任务、结果与最终消息；正文只存于结果。',
  MessageCreatedPayload: '消息创建事件冻结的完整消息及可能关联的输入回执。',
  InputUpdatedPayload: '输入消费变化事件冻结的完整输入回执。',
  OperationUpdatedPayload: '业务操作变化事件冻结的完整操作摘要，本轮尚未产生。',
  ConversationUpdatedFrame: '会话元数据变化的可靠产品事件；按当前存储模式可靠补读。',
  TaskUpdatedFrame: '任务、尝试和累计预算变化的可靠产品事件；按连续序号应用。',
  TaskCompletedFrame: '任务成功交付的可靠产品事件，同时应用任务、结果与消息。',
  MessageCreatedFrame: '消息创建的可靠产品事件，同时提供相关输入回执。',
  MessageUpdatedFrame: '完整消息更新的可靠产品事件，用于停止或失败后收敛临时文字。',
  InputUpdatedFrame: '用户输入消费变化的可靠产品事件，不等同于消息已显示。',
  OperationUpdatedFrame: '业务操作状态变化的可靠产品事件，本轮尚未产生。',
  ReadyControlFrame: '订阅基线已接受的控制帧；观察到的头水位不能直接用来跳过事件。',
  ResetControlFrame: '要求重建快照的控制帧；客户端不得静默跳号或继续使用旧基线。',
  ReauthenticateControlFrame: '身份需要重新验证的控制帧；不授予新的访问资格。',
  RetryControlFrame: '暂时故障或慢消费者的重连建议；不携带可靠事件游标。',
  UserInput: '用户本次正文及明确保留的业务上下文；网络核实时原样复用。',
  StartTaskCommand:
    '当前会话没有未完成目标时创建后续任务，复用已绑定的 Pi 原生上下文；会话创建时未指定标题的，首条受理用户输入会折叠空白并取前 80 个 Unicode 码点更新标题，显式标题和后续追问不改标题，不额外调用模型。',
  ProvideInputCommand: '仅向 waiting_input 目标补充输入的产品命令，本轮尚未开放。',
  ContinueTaskCommand: '沿原目标创建后续尝试的产品命令，本轮尚未开放。',
  RetryTaskCommand: '沿原目标和固定配置重试失败尝试的产品命令，本轮尚未开放。',
  StopAttemptCommand: '停止明确指定尝试的产品命令；已受理与实际停止分别确认。',
  UnconfirmedError: '本次尚无可披露的原命令裁决的诊断；command 为 null 不证明命令从未执行。',
  AppliedResponse: '命令已应用响应，command 和 decision 是冻结的原裁决。',
  RejectedResponse: '命令已记录拒绝响应，原拒绝同 key 重放时保持不变。',
  UnconfirmedResponse: '没有可确认命令裁决的响应；保留原 URL、key 和正文核实。',
  Applied202Response: '命令已受理的 HTTP 202 响应；执行进度通过查询和事件观察。',
  Applied200Response: '命令已明确裁决的 HTTP 200 响应；不会重新启动已结束目标。',
};
const values: Record<string, string> = {
  '1': '版本一',
  '200': '已确认或已结束',
  '202': '已受理，执行尚未完成',
  '409': '已记录的状态拒绝',
  false: '未重放',
  start_task: '创建新目标',
  stop_attempt: '停止指定尝试',
  continue_task: '继续原目标，本轮未开放',
  retry_task: '重试原目标，本轮未开放',
  provide_input: '仅向待补充目标补充，本轮未开放',
  business_query: '普通问答',
  scheduling_draft: '排班草案，本轮未开放',
  schedule_draft: '业务草案对象',
  queued: '已安排',
  running: '执行中',
  waiting_input: '等待补充',
  stopping: '停止已受理，等待实际收敛',
  stopped: '实际已停止',
  interrupted: '执行中断',
  failed: '执行失败',
  completed: '结果已交付',
  needs_input: '本尝试以待补充结束',
  pending: '尚未消费',
  consumed: '已由 Pi 消费',
  handled: '已处理',
  in_progress: '生成中',
  complete: '展示内容完整',
  initial: '首次执行',
  continue: '继续',
  retry: '重试',
  applied: '命令已应用',
  rejected: '命令已拒绝',
  none: '无需进一步动作',
  text: '安全文字块',
  user_input: '用户输入',
  assistant_output: '助手输出',
  notice: '可信产品提示',
  answer: '最终文字回答',
  prepared: '业务操作已准备',
  processing: '业务操作处理中',
  succeeded: '执行已成功',
  failed_no_effect: '业务确认失败且无效果',
  unknown: '业务效果未知',
  conflicted: '业务事实冲突',
  product: '可靠产品事件，PostgreSQL 模式从冻结 outbox 补读',
  control: '连接控制帧',
  delta: '临时文字增量',
  ready: '订阅基线已接受',
  resync_required: '需要重建快照',
  reauthenticate: '重新验证身份',
  server_retry: '服务建议延后重连',
  slow_consumer: '客户端消费过慢',
  reload_snapshot: '重取完整快照',
  resend_same_request: '保留原 key 和全部原语义核实',
  refresh_then_decide: '刷新状态后由用户重新决定',
  fix_request: '修正明确的协议问题',
  contact_support: '保留请求关联号并排查',
  refresh_conversation_list: '刷新列表核实空会话创建',
  duration: '执行期限',
  model_requests: '模型授权次数',
  tool_calls: '工具授权次数',
  'conversation.updated': '会话变化',
  'task.updated': '任务与尝试变化',
  'task.completed': '任务交付',
  'message.created': '创建消息',
  'message.updated': '完整消息变化',
  'input.updated': '输入消费变化',
  'operation.updated': '业务操作变化',
  'tool.updated': '工具过程变化',
  cancelled: '工具已取消',
  invalid_arguments: '工具参数校验失败',
  tool_failed: '工具执行失败',
  budget_exceeded: '预算关闭导致工具取消',
  timeout: '工具执行超时',
  stream_changed: '事件流变更',
  cursor_expired: '游标已裁剪',
  cursor_ahead: '游标超过服务端水位',
  event_gap: '可靠事件缺口',
  TASK_CREATED: '任务已创建',
  INPUT_ACCEPTED: '补充已受理',
  ATTEMPT_CREATED: '新尝试已创建',
  ATTEMPT_REUSED: '复用同语义尝试',
  STOP_REQUESTED: '停止已登记',
  STOP_ALREADY_REQUESTED: '此前已登记停止',
  TARGET_ALREADY_ENDED: '指定尝试已结束',
  UNFINISHED_TASK_EXISTS: '会话仍有未完成目标',
  TASK_COMPLETED: '原任务已完成',
  STOP_IN_PROGRESS: '正在停止',
  STALE_ATTEMPT_TARGET: '目标尝试已过期',
  TASK_STATE_CONFLICT: '当前任务状态不允许此操作',
  TASK_VERSION_CONFLICT: '用户观察版本已变化',
  TASK_SCOPE_CONFLICT: '业务范围冲突',
  IDEMPOTENCY_KEY_CONFLICT: '同 key 使用了不同原意图',
  INVALID_JSON: 'JSON 编码、语法或键不合法',
  INVALID_REQUEST: '字段或参数不符合契约',
  UNSUPPORTED_SCHEMA_VERSION: '公开版本不支持',
  UNAUTHENTICATED: '身份未验证',
  FORBIDDEN: '缺少权限',
  RESOURCE_NOT_FOUND: '资源不存在或不可访问',
  REQUEST_TOO_LARGE: '请求超过 128 KiB',
  UNSUPPORTED_MEDIA_TYPE: '仅接受 JSON',
  SERVICE_UNAVAILABLE: '服务暂不可用',
  INTERNAL_ERROR: '内部错误',
  COMMAND_OUTCOME_UNKNOWN: '原命令结果尚不能确认',
  CREATE_OUTCOME_UNKNOWN: '空会话创建结果尚不能确认',
  INVALID_CURSOR: '分页游标不合法',
  STREAM_CHANGED: '事件流已变化',
  CURSOR_AHEAD: '游标超过当前水位',
  CURSOR_EXPIRED: '游标之前事件已裁剪',
  EVENT_HISTORY_GAP: '事件日志存在缺口',
};

function describe(value: unknown, field: string): unknown {
  if (Array.isArray(value)) return value.map((item) => describe(item, field));
  if (!value || typeof value !== 'object') return value;
  const source = value as Json;
  const result: Json = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === '$ref')
      result[key] = String(entry).replace('#/$defs/', 'urn:tyde:agent:api:') + '#';
    else if (key === 'properties')
      result[key] = Object.fromEntries(
        Object.entries(entry as Json).map(([name, schema]) => [name, describe(schema, name)]),
      );
    else if (['items', 'oneOf', 'anyOf', 'allOf'].includes(key))
      result[key] = describe(entry, field);
    else if (key !== 'default') result[key] = entry;
  }
  if (!result.$ref) {
    const existing = typeof result.description === 'string' ? result.description : '';
    const description = /[\u4e00-\u9fff]/.test(existing)
      ? existing
      : (labels[field] ?? schemaDescriptions[field]);
    if (!description) throw new Error(`AGENT_UNDOCUMENTED_SCHEMA:${field}`);
    result.description = description;
    const enumeration = result.enum as unknown[] | undefined;
    const options = enumeration ?? ('const' in result ? [result.const] : []);
    if (options.length)
      result.description += ` 取值：${options
        .map((v) => {
          const explanation =
            field === 'input_state_at_decision' && v === 'none'
              ? '本命令没有新输入'
              : values[String(v)];
          if (!explanation) throw new Error(`AGENT_UNDOCUMENTED_ENUM:${String(v)}`);
          return `${String(v)}=${explanation}`;
        })
        .join('；')}。`;
  }
  return result;
}

type Operation = {
  summary: string;
  description?: string;
  operationId: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema: Json;
  }[];
  requestBody?: {
    content: Record<string, { schema: Json; examples?: Record<string, { value: unknown }> }>;
  };
  responses: Record<
    string,
    {
      description: string;
      content?: Record<
        string,
        { schema: Json; examples?: Record<string, { value: unknown }>; example?: unknown }
      >;
    }
  >;
};
const operations = agentContractOperations as unknown as Record<string, Record<string, Operation>>;

/** 同源设计例子转换为本轮真实支持的普通问答；不改写源快照或运行契约。 */
function currentExample(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(currentExample);
  if (!value || typeof value !== 'object') return value;
  const source = value as Json;
  const result = Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [
      key,
      key === 'task_kind' ? 'business_query' : key === 'operations' ? [] : currentExample(entry),
    ]),
  );
  if (source.result_type === 'scheduling_draft') {
    result.result_type = 'answer';
    result.payload = { blocks: [{ type: 'text', text: '潮汐由月球和太阳的引力共同影响。' }] };
    result.verification_summary = { business_scope: {}, data_as_of: null, sources: [] };
  }
  return result;
}

function currentExamples(
  examples: Record<string, { value: unknown }>,
): Record<string, { value: unknown }> {
  const selected = Object.entries(examples).filter(([, example]) => {
    const value = example.value as { command?: { kind?: string } };
    return !value?.command?.kind || ['start_task', 'stop_attempt'].includes(value.command.kind);
  });
  const result = Object.fromEntries(
    selected.map(([name, example]) => [name, { ...example, value: currentExample(example.value) }]),
  );
  // 设计中的重放示例属于 continue；本轮使用真实支持的新任务裁决演示原 key 重放。
  if (result.task_created)
    result.same_key_replayed = {
      ...result.task_created,
      value: { ...(result.task_created.value as Json), replayed: true },
    };
  return result;
}

export function registerContractDocumentation(app: FastifyInstance) {
  for (const [name, schema] of Object.entries(agentContractDocument.$defs))
    app.addSchema({ ...(describe(schema, name) as Json), $id: `urn:tyde:agent:api:${name}` });
}

export function contractRouteSchema(path: string, method: string): FastifySchema {
  const operation = operations[path]![method]!;
  const schema: FastifySchema = {
    summary: operation.summary,
    description: `${operation.summary}。PostgreSQL 模式持久保存会话、冻结裁决、工具过程和事件，重启只恢复展示；显式开发内存模式重启清空。只开放 business_query 的 start_task 和 stop_attempt，其余命令与草案未实现。所有资源通过 Bearer 身份验证及私有归属检查。创建空会话 POST 非幂等，禁止自动重试；命令 POST 必须以原 key、正文、context、目标和版本重试，支持按 key 只读核实。查询不修改任务。工具过程使用独立 tool_executions/tool.updated 安全投影，不生成业务 Operation；工具和 Skill 仅由可信宿主显式注入，PostgreSQL 启动要求匹配的已发布资源与执行配置，默认入口不加载演示内容。未知可靠事件失败关闭，旧严格客户端须配套升级。SSE 必须先应用 snapshot 和水位，再订阅其后的事件；Last-Event-ID 不受理，超期或缺口须重新取快照。停止受理与实际停止分别确认。关闭订阅、刷新或重连均不启动或停止执行。`,
    operationId: operation.operationId,
    tags: ['Agent'],
    security: [{ AgentBearer: [] }],
    response: Object.fromEntries(
      Object.entries(operation.responses).map(([code, response]) => {
        const media = response.content?.['application/json'];
        return [
          code,
          media
            ? {
                ...(describe(media.schema, 'data') as Json),
                description: response.description,
                ...(media.examples
                  ? { examples: Object.values(media.examples).map((v) => v.value) }
                  : {}),
              }
            : {
                type: 'string',
                description:
                  '产品 SSE 流，先发送 ready，随后顺序补读 product；delta 与心跳不推进游标。',
              },
        ];
      }),
    ),
  };
  const body = operation.requestBody?.content['application/json'];
  if (body)
    schema.body = {
      ...(describe(body.schema, 'input') as Json),
      ...(body.examples
        ? {
            examples: Object.values(body.examples)
              .filter(
                (v) =>
                  v.value &&
                  typeof v.value === 'object' &&
                  (!('kind' in v.value) ||
                    ['start_task', 'stop_attempt'].includes(String(v.value.kind))),
              )
              .map((v) => v.value),
          }
        : {}),
    };
  for (const location of ['path', 'query'] as const) {
    const parameters = operation.parameters?.filter((v) => v.in === location) ?? [];
    if (parameters.length)
      schema[location === 'path' ? 'params' : 'querystring'] = {
        type: 'object',
        additionalProperties: false,
        description:
          location === 'path'
            ? '资源路径参数，UUID 不授予访问权。'
            : '查询与分页参数，不接受未知字段。',
        properties: Object.fromEntries(
          parameters.map((p) => [
            p.name,
            {
              ...(describe(p.schema, p.name) as Json),
              description: `${p.description ?? labels[p.name] ?? p.name}；${p.required ? '必填' : '可省略'}。`,
            },
          ]),
        ),
        required: parameters.filter((p) => p.required).map((p) => p.name),
      };
  }
  return schema;
}

/** Swagger 的 3.0 转换器会丢失 $ref 同级示例；公开文档按同源 3.1 契约构造。 */
export function transformAgentOpenApi(document: unknown): unknown {
  const output = structuredClone(document) as Json;
  output.openapi = '3.1.0';
  const components = (output.components ??= {}) as Json;
  const schemas = (components.schemas ??= {}) as Json;
  const publicRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(publicRefs);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === '$ref'
          ? String(entry)
              .replace(/^urn:tyde:agent:api:(.+)#$/, '#/components/schemas/$1')
              .replace('#/$defs/', '#/components/schemas/')
          : publicRefs(entry),
      ]),
    );
  };
  for (const [name, schema] of Object.entries(agentContractDocument.$defs))
    schemas[name] = publicRefs(describe(schema, name));
  const paths = output.paths as Json;
  for (const [path, methods] of Object.entries(operations)) {
    const mapped: Json = {};
    for (const [method, original] of Object.entries(methods)) {
      const route = contractRouteSchema(path, method);
      const operation = publicRefs(structuredClone(original)) as Json;
      operation.description = route.description;
      operation.tags = ['Agent'];
      operation.security = [{ AgentBearer: [] }];
      operation.parameters = original.parameters?.map((p) => ({
        ...p,
        description: p.description ?? labels[p.name] ?? `${p.name} 查询条件`,
        schema: publicRefs(describe(p.schema, p.name)),
      }));
      const requestMedia = (operation.requestBody as { content: Record<string, Json> } | undefined)
        ?.content['application/json'];
      if (requestMedia) {
        requestMedia.schema = publicRefs(
          describe(original.requestBody!.content['application/json']!.schema, 'input'),
        );
        const examples = requestMedia.examples as Record<
          string,
          { value: Record<string, unknown> }
        >;
        if (examples)
          requestMedia.examples = Object.fromEntries(
            Object.entries(examples)
              .filter(
                ([, v]) =>
                  !('kind' in v.value) ||
                  ['start_task', 'stop_attempt'].includes(String(v.value.kind)),
              )
              .map(([name, v]) => [
                name,
                v.value.kind === 'start_task'
                  ? {
                      ...v,
                      value: {
                        ...v.value,
                        task_kind: 'business_query',
                        input: { text: '请用两句话解释潮汐现象。', context: {} },
                      },
                    }
                  : v,
              ]),
          );
      }
      for (const [code, response] of Object.entries(original.responses)) {
        const target = (operation.responses as Record<string, { content?: Record<string, Json> }>)[
          code
        ]!;
        const media = response.content?.['application/json'];
        if (media) {
          const targetMedia = target.content!['application/json']!;
          targetMedia.schema = publicRefs(describe(media.schema, 'data'));
          if (media.examples) targetMedia.examples = currentExamples(media.examples);
          if (media.example !== undefined) targetMedia.example = currentExample(media.example);
        }
      }
      mapped[method] = operation;
    }
    paths[path] = mapped;
  }
  return output;
}
