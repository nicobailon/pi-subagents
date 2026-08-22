/**
 * Public project-owned Herdr pane lifecycle API for other Pi extensions.
 *
 * This is the supported extension-to-extension surface. Callers must not
 * import `src/inspectors/herdr/*` directly.
 */
export {
	PROJECT_PANES_API_VERSION,
	PROJECT_PANE_TRUST_STATUS,
	createProjectPaneManager,
	openProjectPane,
	getProjectPaneStatus,
	focusProjectPane,
	closeProjectPane,
	readProjectPaneBinding,
	projectPaneBindingPath,
	type ProjectPaneManager,
	type ProjectPaneManagerOptions,
	type ProjectPaneCommandClient,
	type OpenProjectPaneOptions,
	type GetProjectPaneStatusOptions,
	type CloseProjectPaneOptions,
	type OpenProjectPaneData,
	type ProjectPaneStatusData,
	type FocusProjectPaneData,
	type CloseProjectPaneData,
	type ProjectPaneRuntime,
	type ProjectPaneError,
	type ProjectPaneErrorCode,
	type ProjectPaneResult,
	type HerdrProjectPaneBinding,
} from "../inspectors/herdr/project-panes.ts";
