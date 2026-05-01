import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
	return translate(key, fallback, params);
}

const bundles = [
	{
		locale: "ja",
		namespace: "pi-subagents",
		messages: {
			"slash.bridge.startTimeout": "スラッシュ subagent ブリッジが15秒以内に開始しませんでした。拡張機能が正しく読み込まれていることを確認してください。",
			"slash.status.running": "実行中...",
			"slash.status.liveDetail": "{count} 個のツール{tool} | Ctrl+O でライブ詳細",
			"slash.cancelled": "キャンセルされました",
			"slash.bridge.noResponse": "スラッシュ subagent ブリッジが応答しませんでした。subagent 拡張機能が正しく読み込まれていることを確認してください。",
			"slash.result.running": "Subagent を実行中...",
			"slash.result.heading": "Subagent の結果",
			"slash.result.noOutput": "(出力なし)",
			"slash.result.childSessions": "子セッションのエクスポート",
			"slash.result.savedOutputs": "保存された出力",
			"slash.result.artifactOutputs": "成果物の出力",
			"slash.result.failed": "Subagent が失敗しました",
			"slash.usage.chain": "使用方法: /{command} agent1 \"task1\" -> agent2 \"task2\"",
			"slash.error.unknownAgent": "不明なエージェント: {agent}",
			"slash.error.firstStepTask": "最初のステップにはタスクが必要です: /chain agent \"task\" -> agent2",
			"slash.error.atLeastOneTask": "少なくとも1つのステップにタスクが必要です",
			"slash.cmd.agents": "Agents Manager を開く",
			"slash.cmd.run": "subagent を直接実行: /run agent[output=file] [task] [--bg] [--fork]",
			"slash.usage.run": "使用方法: /run <agent> [task] [--bg] [--fork]",
			"slash.cmd.chain": "エージェントを順番に実行: /chain scout \"task\" -> planner [--bg] [--fork]",
			"slash.cmd.runChain": "保存済みチェーンを実行: /run-chain chainName -- task [--bg] [--fork]",
			"slash.usage.runChain": "使用方法: /run-chain <chainName> -- <task> [--bg] [--fork]",
			"slash.error.unknownChain": "不明なチェーン: {chain}",
			"slash.cmd.parallel": "エージェントを並列実行: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
			"slash.cmd.status": "アクティブまたは最近の非同期 subagent 実行を表示",
			"slash.cmd.doctor": "subagent 診断を表示",
		},
	},
	{
		locale: "zh-CN",
		namespace: "pi-subagents",
		messages: {
			"slash.bridge.startTimeout": "Slash subagent 桥接在 15 秒内未启动。请确认扩展已正确加载。",
			"slash.status.running": "运行中...",
			"slash.status.liveDetail": "{count} 个工具{tool} | Ctrl+O 查看实时详情",
			"slash.cancelled": "已取消",
			"slash.bridge.noResponse": "没有 slash subagent 桥接响应。请确认 subagent 扩展已正确加载。",
			"slash.result.running": "正在运行 subagent...",
			"slash.result.heading": "Subagent 结果",
			"slash.result.noOutput": "（无输出）",
			"slash.result.childSessions": "子会话导出",
			"slash.result.savedOutputs": "已保存输出",
			"slash.result.artifactOutputs": "产物输出",
			"slash.result.failed": "Subagent 失败",
			"slash.usage.chain": "用法: /{command} agent1 \"task1\" -> agent2 \"task2\"",
			"slash.error.unknownAgent": "未知 agent: {agent}",
			"slash.error.firstStepTask": "第一步必须有任务: /chain agent \"task\" -> agent2",
			"slash.error.atLeastOneTask": "至少一个步骤必须有任务",
			"slash.cmd.agents": "打开 Agents Manager",
			"slash.cmd.run": "直接运行 subagent: /run agent[output=file] [task] [--bg] [--fork]",
			"slash.usage.run": "用法: /run <agent> [task] [--bg] [--fork]",
			"slash.cmd.chain": "按顺序运行 agent: /chain scout \"task\" -> planner [--bg] [--fork]",
			"slash.cmd.runChain": "运行已保存的 chain: /run-chain chainName -- task [--bg] [--fork]",
			"slash.usage.runChain": "用法: /run-chain <chainName> -- <task> [--bg] [--fork]",
			"slash.error.unknownChain": "未知 chain: {chain}",
			"slash.cmd.parallel": "并行运行 agent: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
			"slash.cmd.status": "显示活跃和最近的异步 subagent 运行",
			"slash.cmd.doctor": "显示 subagent 诊断信息",
		},
	},
	{
		locale: "es",
		namespace: "pi-subagents",
		messages: {
			"slash.bridge.startTimeout": "El puente de slash subagent no se inició en 15 s. Comprueba que la extensión esté cargada correctamente.",
			"slash.status.running": "ejecutando...",
			"slash.status.liveDetail": "{count} herramientas{tool} | Ctrl+O para detalle en vivo",
			"slash.cancelled": "Cancelado",
			"slash.bridge.noResponse": "Ningún puente de slash subagent respondió. Comprueba que la extensión subagent esté cargada correctamente.",
			"slash.result.running": "Ejecutando subagent...",
			"slash.result.heading": "Resultado de subagent",
			"slash.result.noOutput": "(sin salida)",
			"slash.result.childSessions": "Exportaciones de sesiones hijas",
			"slash.result.savedOutputs": "Salidas guardadas",
			"slash.result.artifactOutputs": "Salidas de artefactos",
			"slash.result.failed": "Subagent falló",
			"slash.usage.chain": "Uso: /{command} agent1 \"task1\" -> agent2 \"task2\"",
			"slash.error.unknownAgent": "Agente desconocido: {agent}",
			"slash.error.firstStepTask": "El primer paso debe tener una tarea: /chain agent \"task\" -> agent2",
			"slash.error.atLeastOneTask": "Al menos un paso debe tener una tarea",
			"slash.cmd.agents": "Abrir Agents Manager",
			"slash.cmd.run": "Ejecutar un subagent directamente: /run agent[output=file] [task] [--bg] [--fork]",
			"slash.usage.run": "Uso: /run <agent> [task] [--bg] [--fork]",
			"slash.cmd.chain": "Ejecutar agentes en secuencia: /chain scout \"task\" -> planner [--bg] [--fork]",
			"slash.cmd.runChain": "Ejecutar una chain guardada: /run-chain chainName -- task [--bg] [--fork]",
			"slash.usage.runChain": "Uso: /run-chain <chainName> -- <task> [--bg] [--fork]",
			"slash.error.unknownChain": "Chain desconocida: {chain}",
			"slash.cmd.parallel": "Ejecutar agentes en paralelo: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
			"slash.cmd.status": "Mostrar ejecuciones async de subagent activas y recientes",
			"slash.cmd.doctor": "Mostrar diagnósticos de subagent",
		},
	},
];

export function initI18n(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
	events.emit("pi-core/i18n/requestApi", {
		namespace: "pi-subagents",
		callback(api: { t?: Translate } | undefined) {
			if (typeof api?.t === "function") translate = api.t;
		},
	});
}
