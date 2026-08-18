/** Browser shell for the bundled Moss React workbench. @internal */
export const WEB_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f7f7f5" />
    <title>Moss · Agent workspace</title>
    <link rel="stylesheet" href="/assets/workbench.css" />
  </head>
  <body data-moss-surface="workbench">
    <div id="moss-web-root" data-moss-surface="workbench"></div>
    <script type="module" src="/assets/workbench.js"></script>
  </body>
</html>`;
