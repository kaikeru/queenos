/* eslint-disable */
// Hand-written to match `wrangler types --include-runtime=false` (WP0 scaffold, before install); regenerate with `pnpm cf-typegen`.
interface __BaseEnv_Env {
	ORACLE_WORKFLOW: Workflow<Parameters<import("./src/index").OracleWorkflow['run']>[0]['payload']>;
	ARTIFACTS?: Artifacts;
	MEMORY?: VectorizeIndex;
	AI?: Ai;
	ANALYTICS?: AnalyticsEngineDataset;
	QUEEN?: DurableObjectNamespace /* QueenNode from queen */;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
	}
	interface TestEnv {
		ORACLE_WORKFLOW: Workflow<Parameters<import("./src/index").OracleWorkflow['run']>[0]['payload']>;
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
