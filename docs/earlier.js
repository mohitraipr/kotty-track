<!-- Kotty — Exchange/Return Form + Robust Mobile Fallback (v2) -->
<div id="kotty-form-wrapper" style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; color:#0f172a;">
  <script>
    // ==== EDIT THESE ONLY ====
    const FORM_URL = "https://script.google.com/macros/s/AKfycbzXLpBWp6ykL8-8JK_XGSxqHCDzoUS3cFSorYIv_YXDaG4IZW-K8tsUOrwMAX6daLRr/exec";
    const WHATSAPP_NUMBER = "917979026089"; // 91 + number (no +, no spaces)
    const SUPPORT_EMAIL = "mohit@kotty.in";
    const FALLBACK_TIMEOUT_MS = 8000;
    // =========================

    // Helpers
    const $ = (sel, root=document) => root.querySelector(sel);
    const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const v = (id) => document.getElementById(id)?.value?.trim() || "";
    const selected = (name) => $(`input[name="${name}"]:checked`)?.value || "";

    function clearRefundFields() {
      $$('input[name="k_refund"]').forEach(r => r.checked = false);
      $("#k_upi").value = "";
      $("#k_accname").value = "";
      $("#k_bank").value = "";
      $("#k_accno").value = "";
      $("#k_ifsc").value = "";
    }

    function setRefundSection(enabled) {
      const sec = $("#k_refund_section");
      const inputs = $$('input[name="k_refund"], #k_upi, #k_accname, #k_bank, #k_accno, #k_ifsc');
      if (enabled) {
        sec.style.display = "block";
        inputs.forEach(el => el.disabled = false);
      } else {
        sec.style.display = "none";
        inputs.forEach(el => el.disabled = true);
        // also hide conditional rows
        $("#k_upi_row").style.display = "none";
        $$(".k_bank_row").forEach(r => r.style.display = "none");
      }
    }

    function syncPurchaseToRefund() {
      const p = selected("k_purchase");
      if (p === "Prepaid") {
        clearRefundFields();
        setRefundSection(false);
      } else if (p === "COD") {
        setRefundSection(true);
        syncRefundFields();
      } else {
        clearRefundFields();
        setRefundSection(false);
      }
    }

    function syncRefundFields() {
      const r = selected("k_refund");
      if (r === "UPI") {
        $("#k_upi_row").style.display = "grid";
        $$(".k_bank_row").forEach(r => r.style.display = "none");
      } else if (r === "Bank") {
        $("#k_upi_row").style.display = "none";
        $$(".k_bank_row").forEach(r => r.style.display = "grid");
      } else {
        $("#k_upi_row").style.display = "none";
        $$(".k_bank_row").forEach(r => r.style.display = "none");
      }
    }

    function buildMessage() {
      const orderId = v("k_order");
      const name = v("k_name");
      const mobile = v("k_mobile");
      const purchase = selected("k_purchase");
      const refund = purchase === "COD" ? selected("k_refund") : ""; // ignore if Prepaid
      const upi = v("k_upi");
      const accName = v("k_accname");
      const bank = v("k_bank");
      const accNo = v("k_accno");
      const ifsc = v("k_ifsc");
      const reason = v("k_reason");

      let refundBlock = "";
      if (purchase === "COD") {
        if (refund === "UPI" && upi) refundBlock = `Refund Method: UPI\nUPI ID: ${upi}`;
        if (refund === "Bank" && (accName || bank || accNo || ifsc)) {
          refundBlock = `Refund Method: Bank\nAccount Name: ${accName}\nBank: ${bank}\nA/C No.: ${accNo}\nIFSC: ${ifsc}`;
        }
      }

      return [
        "Hello Kotty Team, I'd like to request a return/refund.",
        orderId ? `Order ID: ${orderId}` : "Order ID: ",
        name ? `Name: ${name}` : "Name: ",
        mobile ? `Mobile: ${mobile}` : "Mobile: ",
        purchase ? `Purchase Type: ${purchase}` : "Purchase Type: ",
        purchase === "COD" && refund ? `Preferred Refund: ${refund}` : (purchase === "COD" ? "Preferred Refund: " : ""),
        refundBlock,
        reason ? `Reason: ${reason}` : "Reason: ",
        "Attachments (if any): "
      ].filter(Boolean).join("\n");
    }

    function openWhatsApp() {
      const msg = encodeURIComponent(buildMessage());
      window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`, "_blank", "noopener");
    }
    function openEmail() {
      const subject = encodeURIComponent("Return/Refund request");
      const msg = encodeURIComponent(buildMessage());
      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${msg}`;
    }
    function openFormNewTab() { window.open(FORM_URL, "_blank", "noopener"); }
    function copyTemplate() {
      const msg = buildMessage();
      navigator.clipboard?.writeText(msg).then(() => {
        const el = $("#k_copy_done"); el.style.opacity = "1"; setTimeout(()=>el.style.opacity="0", 1500);
      });
    }

    function initIframeFallback() {
      const frame = $("#kotty-iframe");
      const ok = $("#kotty-ok");
      const fail = $("#kotty-fail");
      const hint = $("#kotty-open-hint");
      let loaded = false;

      frame.addEventListener("load", () => {
        loaded = true;
        ok.style.display = "block";
        fail.style.display = "none";
        $("#kotty-fallback").dataset.state = "min";
      });
      setTimeout(() => {
        if (!loaded) {
          ok.style.display = "none";
          fail.style.display = "block";
          $("#kotty-fallback").dataset.state = "max";
          hint.style.display = "block";
        }
      }, FALLBACK_TIMEOUT_MS);
    }

    document.addEventListener("DOMContentLoaded", () => {
      // Set iframe src late to avoid Shopify script blockers
      $("#kotty-iframe").src = FORM_URL;

      // Wire segmented controls
      $$('input[name="k_purchase"]').forEach(r => r.addEventListener("change", syncPurchaseToRefund));
      $$('input[name="k_refund"]').forEach(r => r.addEventListener("change", syncRefundFields));
      syncPurchaseToRefund(); // initial

      initIframeFallback();
    });
  </script>

  <style>
    .k-wrap{max-width:900px;margin:0 auto;padding:12px;}
    .k-h1{font-weight:800;letter-spacing:.2px;font-size:clamp(20px,2.6vw,26px);margin:12px 0}
    .k-sub{color:#475569;margin:6px 0 16px}
    .k-card{border:1px solid #e2e8f0;border-radius:16px;padding:16px;box-shadow:0 8px 28px rgba(15,23,42,.06);background:#fff}
    .k-row{display:grid;grid-template-columns:170px 1fr;gap:12px;align-items:center;margin:10px 0}
    .k-row input,.k-row textarea{
      width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:12px;font:inherit
    }
    .k-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
    .k-btn{padding:11px 16px;border-radius:999px;border:1px solid #0ea5e9;background:#0ea5e9;color:#fff;font-weight:700;cursor:pointer}
    .k-btn.alt{background:#fff;color:#0ea5e9}
    .k-mini{font-size:13px;color:#64748b;margin:6px 0}
    .k-ok{display:none;color:#16a34a}
    .k-fail{display:none;color:#b91c1c}
    .k-open-hint{display:none;margin:8px 0 0;}

    /* Segmented radio group */
    .k-seg {display:flex;gap:8px;flex-wrap:wrap}
    .k-seg input[type="radio"]{position:absolute;opacity:0;pointer-events:none}
    .k-seg label{
      display:inline-flex;align-items:center;gap:8px;
      padding:10px 14px;border:1px solid #cbd5e1;border-radius:999px;cursor:pointer;
      user-select:none; transition: all .18s ease; font-weight:600; color:#0f172a; background:#fff;
    }
    .k-seg input[type="radio"]:checked + label{
      border-color:#0ea5e9; box-shadow:0 0 0 3px rgba(14,165,233,.15); color:#0369a1;
    }
    .k-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#e2f5ff;color:#0369a1;font-size:12px;margin-left:8px}
    .k-note{font-size:12px;color:#64748b}
    #k_copy_done{transition:opacity .25s ease;opacity:0;font-size:12px;color:#16a34a;margin-left:6px}

    /* Fallback expand/collapse */
    #kotty-fallback[data-state="min"] .k-card-head{cursor:pointer}
    #kotty-fallback[data-state="min"] .k-card-body{display:none}
    #kotty-fallback[data-state="max"] .k-card-body{display:block}

    /* Responsive */
    @media (max-width:640px){
      .k-row{grid-template-columns:1fr}
      .k-row label{font-weight:700}
    }
  </style>

  <div class="k-wrap">
    <h2 class="k-h1">Order Exchange / Return</h2>
    <p class="k-sub">If the form below doesn’t load on your device, use the options under <strong>“Having trouble?”</strong> to contact us instantly.</p>

    <!-- IFRAME -->
    <div class="k-card" style="overflow:hidden">
      <div id="kotty-ok" class="k-ok">✅ Form loaded.</div>
      <div id="kotty-fail" class="k-fail">⚠️ Having trouble loading the form on this device.</div>
      <iframe id="kotty-iframe" title="Kotty Exchange/Return" style="width:100%;min-height:900px;border:0" sandbox="allow-forms allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer-when-downgrade" loading="lazy"></iframe>
      <div id="kotty-open-hint" class="k-open-hint">
        <button class="k-btn" type="button" onclick="openFormNewTab()">Open the form in a new tab</button>
        <span class="k-mini">If it still doesn’t open, use WhatsApp or Email below.</span>
      </div>
    </div>

    <!-- FALLBACK CONTACT CARD -->
    <div id="kotty-fallback" class="k-wrap" data-state="min" style="padding:0;margin-top:14px">
      <div class="k-card">
        <div class="k-card-head" onclick="this.parentElement.parentElement.dataset.state = (this.parentElement.parentElement.dataset.state==='min'?'max':'min')">
          <strong>Having trouble?</strong>
          <span class="k-badge">Tap to expand</span>
          <div class="k-mini">We’ll collect a few details and route you via WhatsApp or Email.</div>
        </div>
        <div class="k-card-body" style="margin-top:12px">
          <!-- Step 1 -->
          <div class="k-row">
            <label>Purchase Type</label>
            <div class="k-seg">
              <input type="radio" id="k_purchase_prepaid" name="k_purchase" value="Prepaid">
              <label for="k_purchase_prepaid">Prepaid</label>

              <input type="radio" id="k_purchase_cod" name="k_purchase" value="COD">
              <label for="k_purchase_cod">Cash on Delivery (COD)</label>
            </div>
          </div>

          <!-- Step 2 (visible only if COD) -->
          <div id="k_refund_section" style="display:none">
            <div class="k-row">
              <label>Refund Method</label>
              <div class="k-seg">
                <input type="radio" id="k_refund_upi" name="k_refund" value="UPI">
                <label for="k_refund_upi">UPI</label>

                <input type="radio" id="k_refund_bank" name="k_refund" value="Bank">
                <label for="k_refund_bank">Bank Transfer</label>
              </div>
            </div>

            <div id="k_upi_row" class="k-row" style="display:none">
              <label for="k_upi">UPI ID</label>
              <input id="k_upi" placeholder="e.g., name@upi">
            </div>

            <div class="k-row k_bank_row" style="display:none">
<label for="k_accname">Account Name</label><input id="k_accname" placeholder="As per bank">
</div>
            <div class="k-row k_bank_row" style="display:none">
<label for="k_bank">Bank Name</label><input id="k_bank" placeholder="e.g., HDFC Bank">
</div>
            <div class="k-row k_bank_row" style="display:none">
<label for="k_accno">Account Number</label><input id="k_accno" inputmode="numeric" placeholder="XXXXXXXXXXXX">
</div>
            <div class="k-row k_bank_row" style="display:none">
<label for="k_ifsc">IFSC</label><input id="k_ifsc" placeholder="e.g., HDFC0001234">
</div>
          </div>

          <!-- Basic details -->
          <div class="k-row">
<label for="k_order">Order ID</label><input id="k_order" inputmode="numeric" placeholder="e.g., 1234567890">
</div>
          <div class="k-row">
<label for="k_name">Name</label><input id="k_name" placeholder="Your full name">
</div>
          <div class="k-row">
<label for="k_mobile">Mobile</label><input id="k_mobile" inputmode="numeric" placeholder="10-digit mobile">
</div>
          <div class="k-row">
<label for="k_reason">Reason</label><textarea id="k_reason" rows="3" placeholder="Brief reason for return/refund"></textarea>
</div>

          <div class="k-actions">
            <button class="k-btn" type="button" onclick="openWhatsApp()">WhatsApp us</button>
            <button class="k-btn alt" type="button" onclick="openEmail()">Email us</button>
            <button class="k-btn alt" type="button" onclick="copyTemplate()">Copy message</button>
            <span id="k_copy_done">Copied ✓</span>
          </div>

          <p class="k-note" style="margin-top:10px">
            WhatsApp: <a href="https://wa.me/917979026089" target="_blank" rel="noopener">+91 7979026089</a>  • 
            Email: <a href="mailto:mohit@kotty.in">mohit@kotty.in</a><br>
            Privacy: Details are used only to process your exchange/return/refund.
          </p>
        </div>
      </div>
    </div>
  </div>
</div>
