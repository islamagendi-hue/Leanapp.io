import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <p className="font-mono text-sm text-ink-3">404</p>
        <h1 className="h1 mt-2">This page doesn&apos;t exist, or you don&apos;t have access to it.</h1>
        <Link href="/" className="btn mt-6">Go home</Link>
      </div>
    </div>
  );
}
