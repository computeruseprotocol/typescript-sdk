declare module "screenshot-desktop" {
  function screenshot(options?: { format?: string; screen?: number }): Promise<Buffer>;
  export default screenshot;
}
