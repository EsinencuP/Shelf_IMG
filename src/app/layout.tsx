import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shelf Studio — изображения для планограмм',
  description: 'Поиск и подготовка фотографий товаров: Excel → проверка SKU → JPG на белом фоне → ZIP.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
