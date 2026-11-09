import { useEffect, useState } from 'react'
import icon from '../../../resources/icon.png'
import type { AppInfo } from '../../shared/app-info'
import { useT } from '../shared/use-t'

export function AboutPage() {
  const t = useT()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.notch.app.getInfo().then((result) => {
      if (result.ok) setInfo(result.data)
    })
  }, [])

  return (
    <div className="flex items-start gap-4 py-2">
      <img src={icon} alt="" width={48} height={48} className="rounded-[12px]" />
      <div>
        <div className="text-body font-medium">{info?.name ?? 'Developer Notch'}</div>
        {info ? <div className="tabular mt-1 text-small text-graphite">{t('cc.about.version', { version: info.version })}</div> : null}
        <p className="mt-3 max-w-[48ch] text-small text-graphite">{t('cc.about.description')}</p>
      </div>
    </div>
  )
}
