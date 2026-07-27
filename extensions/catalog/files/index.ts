import { overrideRegistry } from "@/ext/overrides";
import { surfaceIds } from "@/ext/dx/surfaces";
import { ProductGrid } from "./ProductGrid";

// catalog 的程式碼強化層(core-v2 §3.6)。
//
// 這裡**不匯出 Extension** —— catalog 本體是宣告式的,住在 declarative_extensions
// 表裡,後台按一下就裝好了。這個模組只做一件事:在 module load 時把自訂的商品格
// 登記進 overrideRegistry。extensions/registry.ts 用 side-effect import 把它拉進
// bundle(`import "./catalog";`,由 `sz-ws-cms add catalog` 自動接上)。
//
// 「rebuild 才點亮」的機制:Workers 不能 runtime 載入程式碼,所以登記只可能發生在
// 已編譯進 bundle 的模組被載入時。移除那行 import(或整個資料夾)= 移除 override
// = 該 surface 退回泛用卡片,**同一份商品資料照樣渲染**。這是 §3.6 的承諾:強化是
// 加法,不是單向 eject。

const EXT_ID = "catalog";
const PRODUCT_TYPE = `${EXT_ID}.product`;
const LIST_SURFACE = surfaceIds.publicList(PRODUCT_TYPE);

/**
 * 登記 catalog 的程式碼強化(v1:只有公開列表)。
 *
 * 冪等:先 has() 再 register()。dev HMR 會重新 evaluate 本模組,而 overrideRegistry
 * 的狀態跨 hot-reload 保留 —— 沒有這道守衛,重新 evaluate 就會撞上 register() 的
 * 重複檢查而 throw。正式部署每個模組只 evaluate 一次,這裡是 no-op。
 */
export function registerCatalogEnhancements(): void {
  if (overrideRegistry.has(EXT_ID, LIST_SURFACE)) return;
  overrideRegistry.register(EXT_ID, LIST_SURFACE, "list", ProductGrid);
}

registerCatalogEnhancements();
