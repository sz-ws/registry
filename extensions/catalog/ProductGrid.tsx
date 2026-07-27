import Link from "next/link";
import { toTypeDef } from "@/ext/dx/runtime";
import { cachedPublicQuery } from "@/ext/dx/content-cache";
import type { ListSurfaceProps } from "@/ext/overrides";
import { MediaImage } from "@/components/ui/media-image";
import { getSetting } from "@/lib/settings";
import { getLocale } from "@/lib/i18n/server";
import { resolveLocalizedString } from "@/lib/i18n/localized";

// catalog 的公開列表覆寫(core-v2 §3.6 的 public:catalog.product:list surface)。
//
// 泛用 ListView 的卡片解剖是靠欄位型別**推斷**的(inferCardConfig:第一個 media 當
// 封面、第一個 text 當標題、第一個 select/date 當副標)。那對「不知道自己在賣什麼」
// 的通用內容是對的,但商品卡少了價格就少了最重要的一行 —— 而價格是 number,推斷
// 邏輯根本不看 number。
//
// 這就是強化層存在的理由:baseline 照樣能跑(拿掉這個檔就退回泛用卡片,同一份資料、
// 同一組路由),但裝了 catalog 的站可以拿到真正像商品的卡片。
//
// props 與泛用 ListView 一模一樣(§3.6 契約:ListSurfaceProps 就是 ListViewProps 的
// 別名),所以 interpret 那邊不需要知道差別。

const PAGE_SIZE = 24;

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"]);

function isImageKey(key: string): boolean {
  return IMAGE_EXTS.has(key.split(".").pop()?.toLowerCase() ?? "");
}

/**
 * 價格顯示。price 是整數,以該幣別實際使用的最小單位計(TWD 就是元)。
 *
 * 用 Intl 而不是自己拼字串:幣別符號的位置、千分位、小數位數各語系不同,而這串字
 * 會出現在每一張卡片上。Intl 認不得的幣別碼(或壞掉的值)就退回「代碼 + 數字」,
 * 不讓一個奇怪的設定值把整個列表變成 500。
 */
function formatPrice(
  value: unknown,
  currency: string,
  locale: string,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

export async function ProductGrid({
  extId,
  contentType,
  detailBase,
}: ListSurfaceProps) {
  const def = toTypeDef(extId, contentType);
  const [{ items }, currency, locale] = await Promise.all([
    cachedPublicQuery(extId, def.type, {
      filter: { status: "published" },
      sort: { field: "createdAt", dir: "desc" },
      page: 1,
      perPage: PAGE_SIZE,
    }),
    getSetting<string>(`ext.${extId}.currency`, "TWD"),
    getLocale(),
  ]);

  const intlLocale = locale === "zh-Hant" ? "zh-TW" : "en-US";
  const heading =
    resolveLocalizedString(contentType.label, locale) ?? contentType.name;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold text-gray-900">{heading}</h1>

      {items.length === 0 ? (
        <p className="text-gray-500">Nothing published yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((entry) => {
            const data = entry.data as Record<string, unknown>;
            const name = typeof data.name === "string" ? data.name : entry.id;
            const summary =
              typeof data.summary === "string" ? data.summary : null;
            const cover = typeof data.image === "string" ? data.image : null;
            const price = formatPrice(
              data.price,
              (currency ?? "TWD").trim() || "TWD",
              intlLocale,
            );
            const href = detailBase && entry.slug ? `${detailBase}/${entry.slug}` : null;

            const card = (
              <>
                {cover && isImageKey(cover) ? (
                  <MediaImage
                    mediaKey={cover}
                    alt=""
                    maxWidth={640}
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 240px"
                    className="aspect-square w-full rounded-[10px] object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded-[10px] bg-black/[0.03] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]">
                    <span className="text-[28px] font-semibold text-black/15">
                      {name.trim().charAt(0).toUpperCase() || "—"}
                    </span>
                  </div>
                )}
                <div className="mt-3 flex flex-col gap-1">
                  <p className="text-[13.5px] font-medium leading-snug text-black/85">
                    {name}
                  </p>
                  {summary && (
                    <p className="line-clamp-2 text-[12px] leading-relaxed text-black/45">
                      {summary}
                    </p>
                  )}
                  {price && (
                    // 價格在最後、字重最重 —— 這是逛商品時眼睛第二個停的地方。
                    <p className="mt-0.5 text-[13px] font-semibold tabular-nums text-black/85">
                      {price}
                    </p>
                  )}
                </div>
              </>
            );

            return (
              <li key={entry.id}>
                {href ? (
                  <Link
                    href={href}
                    className="group block rounded-[12px] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-black/20"
                  >
                    {card}
                  </Link>
                ) : (
                  card
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
