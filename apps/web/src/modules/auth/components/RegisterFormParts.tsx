/** 提供注册表单内部复用的分区和确认密码字段组件。 */
import type { ReactNode } from 'react';
import { passwordPattern } from '@tyde/shared';
import AuthFormField from '@/components/ui/shared/AuthFormField';
import AuthPasswordInput from '@/components/ui/shared/AuthPasswordInput';
import type { RegisterFormController } from '../types';
import { registerInputClassName } from '../styles';

/** 渲染带编号标题和双列表单网格的注册信息区块。 */
export function FormSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-[12px]">
      <div className="mb-[8px] flex items-center gap-[9px]">
        <span className="grid h-[21px] w-[21px] place-items-center rounded-full bg-accent text-[12px] leading-none text-[var(--color-primary-strong)]">
          {number}
        </span>
        <b className="text-[12px] text-foreground">{title}</b>
        <i className="ml-[7px] h-px flex-1 bg-[var(--color-divider)]" />
      </div>
      <div className="grid grid-cols-2 gap-[12px] max-[360px]:grid-cols-1">{children}</div>
    </section>
  );
}

/** 渲染确认密码字段，并展示与密码字段的一致性状态。 */
export function ConfirmPasswordField({
  controller,
  inputNameSuffix,
  password,
  confirmPassword,
}: {
  controller: RegisterFormController;
  inputNameSuffix: string;
  password: string;
  confirmPassword: string;
}) {
  const error = controller.form.formState.errors.confirmPassword;
  const controlId = `register-confirm-password-${inputNameSuffix}`;
  const validationStatus = confirmPassword
    ? password === confirmPassword
      ? new RegExp(passwordPattern).test(password)
        ? 'match'
        : undefined
      : 'mismatch'
    : undefined;

  return (
    <AuthFormField
      htmlFor={controlId}
      label={
        <span className="flex items-center gap-[5px]">
          <span>
            确认密码 <em>*</em>
          </span>
          {validationStatus && (
            <span
              className={`grid h-[16px] w-[16px] place-items-center rounded-full text-[12px] leading-none font-semibold text-white ${validationStatus === 'match' ? 'bg-[var(--color-success)]' : 'bg-destructive'}`}
              role="status"
              aria-label={validationStatus === 'match' ? '两次密码一致' : '两次密码不一致'}
            >
              {validationStatus === 'match' ? '✓' : '✕'}
            </span>
          )}
        </span>
      }
      error={error}
    >
      <AuthPasswordInput
        id={controlId}
        size="authRegister"
        className={registerInputClassName}
        autoComplete="new-password"
        placeholder="请再次输入密码进行核对"
        maxLength={64}
        aria-invalid={Boolean(error)}
        {...controller.form.register('confirmPassword', {
          required: '请再次输入密码',
          validate: (value) =>
            value === controller.form.getValues('password') || '两次输入的密码不一致',
        })}
      />
    </AuthFormField>
  );
}
