import Image from 'next/image';
import { BaseLayout } from '@/components/BaseLayout';
import { PageReady } from '@/components/PageReady';

const links = [
  {
    icon: '/assets/github.svg',
    name: 'shuntaka9576',
    href: 'https://github.com/shuntaka9576',
  },
  {
    icon: '/assets/x.svg',
    name: 'shuntaka_dev',
    href: 'https://x.com/shuntaka_jp',
  },
  {
    icon: '/assets/zenn.svg',
    name: 'shuntaka',
    href: 'https://zenn.dev/shuntaka',
  },
  {
    icon: '/assets/sd.svg',
    name: 'shuntaka',
    href: 'https://speakerdeck.com/shuntaka',
  },
  {
    icon: '/assets/ochaIcon.svg',
    name: 'shuntaka.dev',
    href: 'https://shuntaka.dev',
  },
  {
    icon: '/assets/devio.svg',
    name: 'shuntaka',
    href: 'https://dev.classmethod.jp/author/takahashi-shunichi/',
  },
  {
    icon: '/assets/bluesky.svg',
    name: 'shuntaka.bsky.social',
    href: 'https://bsky.app/profile/shuntaka.bsky.social',
  },
];

export default function WhoPage() {
  return (
    <BaseLayout showTypeHeader currentTab="who">
      <main className="w-full">
        <div className="flex items-center gap-2 pb-2">
          <span>髙橋俊一 a.k.a shuntaka</span>
          <Image src="/icons/hashi-light.png" alt="hashi" width={36} height={36} />
        </div>
        <div className="flex pb-4">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="pr-2 pb-2"
              target="_blank"
              rel="noreferrer"
            >
              <Image src={link.icon} alt={link.name} width={24} height={24} />
            </a>
          ))}
        </div>
        <div className="pb-4">
          <div>Career</div>
          <div className="p-2">
            <p>201204 TDU EC</p>
            <p>201604 株式会社QUICK</p>
            <p>201908 株式会社クラスメソッド</p>
          </div>
        </div>
        <div>
          <div>Like</div>
          <div className="p-2">
            <p>TypeScript</p>
            <p>Go</p>
            <p>Rust</p>
            <p>Neovim</p>
            <p>AWS(Serverless, ECS, etc..)</p>
            <p>Cloudflare</p>
          </div>
        </div>
        <PageReady />
      </main>
    </BaseLayout>
  );
}
