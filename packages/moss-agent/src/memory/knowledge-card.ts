import { LEARNING_TOPIC_SLUGS, type LearningTopicSlug } from './memory-manager.js';
import { truncateLine } from '../utils/text-trim.js';

export interface KnowledgeTurnInput {
  userMessage: string;
  assistantMessage: string;

  toolsUsed?: string[];
}

export interface KnowledgeCardDraft {
  title: string;
  topic: LearningTopicSlug;
  content: string;
}

const TITLE_MAX = 36;
const QUESTION_MAX = 200;
const ANSWER_MAX = 1200;

const TOPIC_KEYWORDS: Array<{ topic: LearningTopicSlug; patterns: RegExp }> = [
  {
    topic: 'vision',
    patterns: /摄像头|相机|图像|视觉|画面|显示|推流|opencv|camera|mipi|rtsp|video|image|display/i,
  },
  {
    topic: 'hbm',
    patterns:
      /模型|推理|量化|算法|bpu|hbm|hbdk|onnx|model\s*zoo|nodehub|tensor|infer|quant|model(?![\s-]*zoo)/i,
  },
  {
    topic: 'ros',
    patterns: /\bros2?\b|tros|话题|节点|launch|rclpy|rclcpp|topic|\bnode\b|colcon/i,
  },
  {
    topic: 'usb',
    patterns: /usb|type-?c|typec|串口|serial|网卡|rndis|插拔|adb/i,
  },
  {
    topic: 'network',
    patterns: /网络|联网|\bip\b|ping|wifi|wi-fi|ssh|frp|端口|\bport\b|防火墙|代理|proxy|dns|网关/i,
  },
  {
    topic: 'deploy',
    patterns:
      /部署|安装|烧录|刷机|固件|镜像|系统|编译|构建|\bapt\b|\bpip\b|docker|deploy|install|flash|firmware|image|build|systemd|service/i,
  },
];

const GREETING =
  /^(你好|您好|哈喽|嗨|在吗|谢谢|多谢|感谢|辛苦了|hi|hello|hey|thanks|thank you|ok|好的|收到)[\s!！。.?？~]*$/i;

const compactLine = truncateLine;
const clamp = truncateLine;

export function classifyLearningTopic(text: string): LearningTopicSlug {
  const t = String(text || '');
  for (const { topic, patterns } of TOPIC_KEYWORDS) {
    if (patterns.test(t)) return topic;
  }
  return 'general';
}

function deriveTitle(userMessage: string): string {
  const firstSentence = String(userMessage || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[。.!！?？\n]/)[0]
    ?.trim();
  const base = firstSentence || String(userMessage || '').trim();

  const cleaned = base.replace(/^(请问|帮我|帮忙|我想|想问一下|问一下|怎么|如何|请)/, '').trim();
  return compactLine(cleaned || base, TITLE_MAX);
}

export function buildKnowledgeCardDraft(input: KnowledgeTurnInput): KnowledgeCardDraft | null {
  const user = String(input.userMessage || '').trim();
  const assistant = String(input.assistantMessage || '').trim();

  if (user.length < 4) return null;
  if (assistant.length < 40) return null;
  if (GREETING.test(user)) return null;

  const topic = classifyLearningTopic(`${user}\n${assistant}`);
  const title = deriveTitle(user);
  if (!title) return null;

  const tools = (input.toolsUsed ?? []).map((t) => String(t || '').trim()).filter(Boolean);

  const lines = [
    title,
    '',
    `问题：${clamp(user, QUESTION_MAX)}`,
    '',
    '解答：',
    clamp(assistant, ANSWER_MAX),
  ];
  if (tools.length > 0) {
    lines.push('', `涉及工具：${tools.join('、')}`);
  }

  return { title, topic, content: lines.join('\n') };
}

const KNOWLEDGE_TOPIC_SET: ReadonlySet<string> = new Set(LEARNING_TOPIC_SLUGS);

export function coerceLearningTopic(input: unknown): LearningTopicSlug | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim().toLowerCase();
  return KNOWLEDGE_TOPIC_SET.has(s) ? (s as LearningTopicSlug) : undefined;
}

const PROJECT_TOPICS: ReadonlySet<LearningTopicSlug> = new Set([
  'usb',
  'ros',
  'hbm',
  'deploy',
  'network',
  'vision',
]);

const PROJECT_SIGNAL =
  /项目|工程|工作区|部署|编译|构建|烧录|刷机|固件|镜像|节点|话题|模型|推理|量化|驱动|外设|板子|开发板|设备|gpio|摄像头|串口|workspace|project|deploy|build|firmware|flash|compile|ros|node|model|bpu|gpio/i;

const ANSWER_SUBSTANTIVE_LEN = 160;

export interface KnowledgeTurnAssessment {
  worth: boolean;

  projectRelated: boolean;
  topic: LearningTopicSlug;
  reason: string;
}

export function assessKnowledgeTurn(input: KnowledgeTurnInput): KnowledgeTurnAssessment {
  const draft = buildKnowledgeCardDraft(input);
  const user = String(input.userMessage || '');
  const assistant = String(input.assistantMessage || '');
  const topic = draft ? draft.topic : classifyLearningTopic(`${user}\n${assistant}`);
  const tools = (input.toolsUsed ?? []).map((t) => String(t || '').trim()).filter(Boolean);

  const projectRelated =
    PROJECT_TOPICS.has(topic) ||
    tools.length > 0 ||
    PROJECT_SIGNAL.test(user) ||
    PROJECT_SIGNAL.test(assistant);

  if (!draft) {
    return { worth: false, projectRelated, topic, reason: '结构门槛未过（问候/过短/空答）' };
  }

  const substantive = assistant.trim().length >= ANSWER_SUBSTANTIVE_LEN;
  const worth = projectRelated || tools.length > 0 || substantive;
  const reason = worth
    ? projectRelated
      ? '项目/设备相关，优先沉淀'
      : tools.length > 0
        ? '用到工具，具备可复用操作'
        : '答案充实，值得沉淀'
    : '可入手动复核，但不达自动沉淀门槛（疑似闲聊/琐碎）';
  return { worth, projectRelated, topic, reason };
}
