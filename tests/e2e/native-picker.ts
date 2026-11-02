import { expect, type Locator } from '@playwright/test';

/** 验证公共日期控件点击主体开选择器，测试结束恢复实例的原生方法。 */
export async function expectPickerOnBodyClick(input: Locator) {
  await expect(input).toHaveAttribute('data-slot', 'input');
  const value = await input.inputValue();
  await input.evaluate((node: HTMLInputElement) => {
    node.dataset.pickerCallCount = '0';
    Object.defineProperty(node, 'showPicker', {
      configurable: true,
      value() {
        node.dataset.pickerCallCount = String(Number(node.dataset.pickerCallCount) + 1);
      },
    });
  });
  try {
    await input.click({ position: { x: 12, y: 12 } });
    await expect(input).toHaveAttribute('data-picker-call-count', '1');
    await expect(input).toHaveValue(value);
  } finally {
    await input.evaluate((node: HTMLInputElement) => {
      Reflect.deleteProperty(node, 'showPicker');
      delete node.dataset.pickerCallCount;
    });
  }
}
