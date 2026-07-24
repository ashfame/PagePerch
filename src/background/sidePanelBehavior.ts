export interface SidePanelBehaviorApi {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
}

export async function enableActionSidePanel(
  sidePanel: SidePanelBehaviorApi,
): Promise<void> {
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
