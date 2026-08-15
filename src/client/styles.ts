export const ROLE_STYLES = `
/* ---- Role card grid (settings.plugins.tab content) ---- */
.shiori-role-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:12px;max-width:760px}
.shiori-role-card{position:relative;min-height:244px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:inherit;text-align:left;cursor:pointer;transition:border-color .16s ease,transform .16s ease}
.shiori-role-card:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}
.shiori-role-card__art{position:absolute;inset:0;background-position:center top;background-size:cover;background-repeat:no-repeat}
.shiori-role-card__shade{position:absolute;inset:35% 0 0;background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-layer-1) 78%)}
.shiori-role-card__copy{position:absolute;inset:auto 14px 14px;z-index:1}
.shiori-role-card__name{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.shiori-role-card__intro{display:-webkit-box;margin-top:4px;overflow:hidden;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);-webkit-box-orient:vertical;-webkit-line-clamp:2}
.shiori-role-card--create{display:grid;place-items:center;min-height:244px;color:var(--dsw-alias-label-tertiary);background:transparent}
.shiori-role-create__body{display:grid;justify-items:center;gap:8px}

/* ---- Role edit modal ---- */
.shiori-role-modal{width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 32px)}
.shiori-role-modal__content{min-height:0;overflow-y:auto}
.shiori-role-form{display:grid;gap:18px}
.shiori-role-field{display:grid;gap:6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.shiori-role-field textarea{min-height:150px;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5;transition:border-color .16s ease,box-shadow .16s ease}
.shiori-role-field textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.shiori-role-media-row{display:grid;grid-template-columns:repeat(2,minmax(0,180px));gap:12px;align-items:start}
.shiori-role-upload{position:relative;display:grid;place-items:center;aspect-ratio:1/1;overflow:hidden;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer;color:var(--dsw-alias-label-tertiary)}
.shiori-role-upload--portrait{aspect-ratio:3/4}
.shiori-role-upload img{width:100%;height:100%;object-fit:cover}
.shiori-role-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}
.shiori-role-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
.shiori-role-gallery__item{position:relative;aspect-ratio:1;overflow:hidden;border-radius:8px;background:var(--dsw-alias-bg-base)}
.shiori-role-gallery__item img{width:100%;height:100%;object-fit:cover}
.shiori-role-gallery__remove{position:absolute;top:4px;right:4px;width:26px;height:26px;border:0;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer}
.shiori-role-gallery__select{position:absolute;top:4px;left:4px;width:26px;height:26px;border:0;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer}
.shiori-role-gallery__select:hover{color:var(--dsw-alias-label-primary)}
.shiori-role-background{display:grid;grid-template-columns:minmax(0,120px) 1fr;gap:12px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.shiori-role-background__preview{position:relative;aspect-ratio:3/4;overflow:hidden;border-radius:6px;background:var(--dsw-alias-bg-base)}
.shiori-role-background__preview img{width:100%;height:100%;object-fit:cover}
.shiori-role-background__copy{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.shiori-role-background__title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.shiori-role-background__hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.shiori-role-background__clear{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:none;cursor:pointer}
.shiori-role-background__clear:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.shiori-role-background__clear:disabled{opacity:.5;cursor:default}
.shiori-role-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.shiori-role-footer{display:flex;justify-content:space-between;gap:10px;width:100%}
.shiori-role-footer__right{display:flex;gap:8px;margin-left:auto}

/* ---- Composer role selector chip ---- */
.shiori-role-chip{display:inline-flex;align-items:center;gap:7px;max-width:150px;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.shiori-role-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.shiori-role-chip:disabled{cursor:default;opacity:.78}
.shiori-role-chip__avatar{width:18px;height:18px;flex:none;overflow:hidden;border-radius:50%;background:var(--dsw-alias-bg-layer-2)}
.shiori-role-chip__avatar img{width:100%;height:100%;object-fit:cover}
.shiori-role-chip__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---- Memory settings card (settings.plugin.item): mirrors host PluginCard chrome ---- */
.shiori-role-memory-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.shiori-role-memory-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.shiori-role-memory-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.shiori-role-memory-card__header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.shiori-role-memory-card__header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.shiori-role-memory-card__head{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.shiori-role-memory-card__name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.shiori-role-memory-card__description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.shiori-role-memory-card__chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.shiori-role-memory-card--open .shiori-role-memory-card__chevron{transform:rotate(180deg)}
.shiori-role-memory-card__pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.shiori-role-memory-card__body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0 8px}
.shiori-role-memory-card__hint{margin:0 0 12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.shiori-role-memory-card__status{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.shiori-role-memory-card__failed{margin:0 0 4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.shiori-role-memory-card__footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.shiori-role-memory-card__discard,.shiori-role-memory-card__save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.shiori-role-memory-card__discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.shiori-role-memory-card__discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.shiori-role-memory-card__save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.shiori-role-memory-card__discard:disabled,.shiori-role-memory-card__save:disabled{opacity:.4;cursor:default}
.shiori-role-memory-card__discard:focus-visible,.shiori-role-memory-card__save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.shiori-role-memory__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:4px}
.shiori-role-memory__endpoint{margin:0;padding:12px;display:grid;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.shiori-role-memory__endpoint legend{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);padding:0 4px}

/* ---- Role-owned theme layer ---- */
.shiori-role-theme [data-sidebar-collapsed]>div:first-child{background-image:linear-gradient(rgba(0,0,0,.22),rgba(0,0,0,.22)),var(--shiori-role-art);background-image:linear-gradient(var(--shiori-role-overlay),var(--shiori-role-overlay)),var(--shiori-role-art);background-position:center;background-size:cover;background-repeat:no-repeat}
.shiori-role-theme [data-conversation-scroll]{background-image:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.25)),var(--shiori-role-art);background-image:linear-gradient(var(--shiori-role-workspace-overlay),var(--shiori-role-workspace-overlay)),var(--shiori-role-art);background-position:center;background-size:cover;background-repeat:no-repeat;background-attachment:fixed}

@media(max-width:640px){
  .shiori-role-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .shiori-role-card,.shiori-role-card--create{min-height:210px}
  .shiori-role-media-row{grid-template-columns:1fr}
  .shiori-role-upload{max-width:160px}
}
@media(prefers-reduced-motion:reduce){
  .shiori-role-card{transition:none}
}
`
