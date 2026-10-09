// "Products / Configure" style page heading used by the detail pages.
export default function Breadcrumb({ current }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <a href="#/">Products</a>
      <span aria-hidden="true"> / </span>
      <strong>{current}</strong>
    </nav>
  );
}
