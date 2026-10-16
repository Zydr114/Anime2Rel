import { t } from '@/i18n'
import type { AssetRef } from '@/state/assets'
import { useApp } from '@/state/store'
import { BitmapThumb } from '@/ui/BitmapThumb'
import { pickFiles } from '../importer'

function AssetCard({ title, asset, actions }: { title: string; asset: AssetRef | null; actions: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex gap-1">{actions}</div>
      </div>
      {asset ? (
        <div className="flex gap-3">
          <BitmapThumb assetId={asset.id} maxEdge={96} className="shrink-0" />
          <div className="min-w-0 text-xs leading-5 text-on-surface-variant">
            <div className="truncate text-on-surface" title={asset.name}>
              {asset.name}
            </div>
            <div>{t.assets.size(asset.width, asset.height)}</div>
            {(asset.sourceWidth !== asset.width || asset.sourceHeight !== asset.height) && (
              <div>{t.assets.downscaled(asset.sourceWidth, asset.sourceHeight)}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-xs text-on-surface-variant">{t.assets.none}</div>
      )}
    </section>
  )
}

export function AssetsPanel() {
  const background = useApp((s) => s.doc.background)
  const character = useApp((s) => s.doc.character)
  const setCharacter = useApp((s) => s.setCharacter)

  return (
    <div className="flex flex-col gap-3">
      <AssetCard
        title={t.assets.background}
        asset={background}
        actions={
          <mdui-button variant="text" onClick={() => pickFiles('background')} data-testid="replace-background">
            {t.assets.replace}
          </mdui-button>
        }
      />
      <AssetCard
        title={t.assets.character}
        asset={character}
        actions={
          character ? (
            <>
              <mdui-button variant="text" onClick={() => pickFiles('character')}>
                {t.assets.replace}
              </mdui-button>
              <mdui-button variant="text" onClick={() => setCharacter(null)} data-testid="remove-character">
                {t.assets.remove}
              </mdui-button>
            </>
          ) : (
            <mdui-button variant="tonal" onClick={() => pickFiles('character')} data-testid="add-character">
              {t.assets.add}
            </mdui-button>
          )
        }
      />
      <p className="px-1 text-xs leading-5 text-on-surface-variant">{t.assets.dropHint}</p>
    </div>
  )
}
