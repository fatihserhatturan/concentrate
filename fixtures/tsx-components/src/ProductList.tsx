import { formatPrice } from './format';

export type Product = { id: string; name: string; cents: number };

// A generic arrow needs the trailing comma in .tsx.
export const firstOf = <T,>(items: T[]): T | undefined => items[0];

export function trackClick(id: string) {
  console.log('clicked', id);
}

export function ProductList({ products }: { products: Product[] }) {
  const featured = firstOf(products);
  return (
    <ul className="products">
      {featured && <li className="featured">{featured.name}</li>}
      {products.map((product) => (
        <li key={product.id} onClick={() => trackClick(product.id)}>
          {product.name} {formatPrice(product.cents)}
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const products = [{ id: 'a', name: 'Lamp', cents: 1999 }] as Product[];
  return <ProductList products={products} />;
}
