import json, urllib.request, asyncio, sys
from playwright.async_api import async_playwright
B = "http://127.0.0.1:8600"
req = urllib.request.Request(B + "/api/auth/login", data=json.dumps({"email": "e2e-test@plasma.local", "password": "e2e-test-password"}).encode(), headers={"Content-Type": "application/json"})
tok = json.load(urllib.request.urlopen(req))["token"]
TID = sys.argv[1]
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=["--no-sandbox"])
        for name, vw, vh, theme in [("desktop", 1500, 950, "light"), ("dark", 1500, 950, "dark"), ("mobile", 390, 844, "light")]:
            ctx = await br.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=1, locale="zh-TW")
            await ctx.add_init_script(f"localStorage.setItem('pa_token', {json.dumps(tok)}); localStorage.setItem('pa_theme', '{theme}');")
            page = await ctx.new_page()
            await page.goto(f"{B}/#/t/{TID}")
            await page.wait_for_timeout(3500)
            await page.screenshot(path=f"/out/{name}.png")
            if name == "desktop":
                await page.mouse.wheel(0, -100000); await page.wait_for_timeout(500)
                await page.locator(".steps-head").last.click(); await page.wait_for_timeout(400)
                await page.screenshot(path="/out/expanded.png")
                btn = page.locator(".step-open").last
                await btn.click(); await page.wait_for_timeout(1500)
                await page.screenshot(path="/out/detail.png")
                await page.locator(".panel-tabs button", has_text="檔案").click(); await page.wait_for_timeout(800)
                if len(sys.argv) > 2:
                    for part in sys.argv[2].split("/"):
                        await page.locator(".file-row", has_text=part).first.click(); await page.wait_for_timeout(800)
                await page.screenshot(path="/out/files.png")
                await page.goto(f"{B}/#/"); await page.reload(); await page.wait_for_timeout(1500)
                await page.locator(".brand").first.click(); await page.wait_for_timeout(1000)
                await page.screenshot(path="/out/welcome.png")
            await ctx.close()
        await br.close()
asyncio.run(main())
