/** 共用手机号字段，按登录方式展示验证码或密码。 */
import { LockIcon, PhoneIcon, ShieldCheckIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import AuthFormField from '@/components/ui/shared/AuthFormField';
import AuthPasswordInput from '@/components/ui/shared/AuthPasswordInput';
import type { LoginFormController } from '../types';
import { loginInputClassName, submitButtonClassName } from '../styles';

function LoginInputIcon({ type }: { type: 'phone' | 'code' | 'password' }) {
  return (
    <span className="pointer-events-none absolute top-1/2 left-[12px] z-10 -translate-y-1/2 text-muted-foreground [&_svg]:h-[17px] [&_svg]:w-[17px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:1.7]">
      {type === 'phone' ? <PhoneIcon /> : type === 'code' ? <ShieldCheckIcon /> : <LockIcon />}
    </span>
  );
}

export default function LoginFormPanel({ controller }: { controller: LoginFormController }) {
  const { mode, form, submitting, sms, actions } = controller;
  const { errors } = form.formState;

  return (
    <form
      className="grid gap-[24px]"
      autoComplete={mode === 'password' ? 'on' : 'off'}
      noValidate
      onSubmit={form.handleSubmit(actions.finish)}
    >
      <AuthFormField htmlFor="login-account" label="手机号" required error={errors.account}>
        <div className="relative min-w-0">
          <LoginInputIcon type="phone" />
          <Input
            id="login-account"
            size="auth"
            className={`${loginInputClassName} pl-[41px]`}
            type="tel"
            inputMode="numeric"
            autoComplete={mode === 'password' ? 'username' : 'tel-national'}
            disabled={sms.sending || submitting}
            maxLength={11}
            placeholder="请输入手机号"
            required
            aria-invalid={Boolean(errors.account)}
            {...form.register('account', {
              required: '请输入手机号',
              pattern: { value: /^1[3-9]\d{9}$/, message: '请输入 11 位大陆手机号码' },
              onChange: actions.changeAccount,
            })}
          />
        </div>
      </AuthFormField>
      {mode === 'password' ? (
        <AuthFormField htmlFor="login-password" label="密码" required error={errors.password}>
          <div className="relative min-w-0">
            <LoginInputIcon type="password" />
            <AuthPasswordInput
              id="login-password"
              size="auth"
              className={`${loginInputClassName} pl-[41px]`}
              autoComplete="current-password"
              disabled={submitting}
              maxLength={64}
              placeholder="请输入密码"
              required
              aria-invalid={Boolean(errors.password)}
              {...form.register('password', { required: '请输入密码' })}
            />
          </div>
        </AuthFormField>
      ) : (
        <AuthFormField htmlFor="login-code" label="验证码" required error={errors.code}>
          <div className="relative min-w-0">
            <LoginInputIcon type="code" />
            <Input
              id="login-code"
              size="auth"
              className={`${loginInputClassName} pr-[100px] pl-[41px]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={submitting}
              minLength={4}
              maxLength={8}
              placeholder="请输入验证码"
              required
              aria-invalid={Boolean(errors.code)}
              {...form.register('code', {
                required: '请输入验证码',
                minLength: { value: 4, message: '请输入 4～8 位验证码' },
                maxLength: { value: 8, message: '请输入 4～8 位验证码' },
              })}
            />
            <Button
              type="button"
              variant="link"
              size="formControl"
              className="absolute top-1/2 right-[3px] -translate-y-1/2 px-[7px] font-[650] hover:no-underline"
              disabled={sms.sending || submitting || sms.countdown > 0}
              aria-busy={sms.sending || undefined}
              onClick={sms.send}
            >
              {sms.sending
                ? '发送中'
                : sms.countdown > 0
                  ? `${sms.countdown}s 后重发`
                  : '获取验证码'}
            </Button>
          </div>
        </AuthFormField>
      )}
      <Button
        type="submit"
        size="authSubmit"
        className={submitButtonClassName}
        loading={submitting}
        disabled={sms.sending}
      >
        {submitting ? '验证中...' : mode === 'password' ? '登录' : '继续'}
      </Button>
    </form>
  );
}
