/**
 * Vercel Edge: актуальный index.html из GitHub main + nav-fix.js для устаревшей статики.
 */
export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return;
  }

  const fixScript =
    '<script src="https://cdn.jsdelivr.net/gh/GithubRavilS/Defi-Labs-Navigator@main/nav-fix.js"></script>';

  try {
    const gh = await fetch(
      "https://raw.githubusercontent.com/GithubRavilS/Defi-Labs-Navigator/main/index.html",
      { headers: { "cache-control": "no-cache" } },
    );
    if (gh.ok) {
      let html = await gh.text();
      if (!html.includes("POOL_BATTLE_COL") && !html.includes("nav-fix.js")) {
        html = html.replace("</head>", fixScript + "\n</head>");
      }
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
          "x-defilabs-source": "github-main",
        },
      });
    }
  } catch (e) {}

  try {
    const origin = await fetch(new URL("/index.html", request.url));
    if (!origin.ok) return;
    let html = await origin.text();
    if (!html.includes("POOL_BATTLE_COL") && !html.includes("nav-fix.js")) {
      html = html.replace("</head>", fixScript + "\n</head>");
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
          "x-defilabs-source": "static+nav-fix",
        },
      });
    }
  } catch (e2) {}

  return;
}

export const config = {
  matcher: ["/", "/index.html"],
};
