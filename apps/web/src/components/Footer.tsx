import Link from 'next/link';

export function Footer() {
  return (
    <div className="w-full p-4">
      <Link href="/" prefetch={false}>
        <div className="block text-center text-xs">shuntaka.dev</div>
      </Link>
      <p className="text-center text-xs">This site uses Google Analytics.</p>
    </div>
  );
}
