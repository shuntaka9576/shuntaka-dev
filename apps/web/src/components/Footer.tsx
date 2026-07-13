import Image from 'next/image';
import Link from 'next/link';

export function Footer() {
  return (
    <div className="flex w-full justify-center p-4">
      <Link href="/" prefetch={false} aria-label="shuntaka.dev トップへ">
        <Image src="/assets/ochaIcon.svg" alt="" width={22} height={22} />
      </Link>
    </div>
  );
}
