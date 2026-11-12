'use strict';
'require honk.service as service';

/*
 * 日志页。和 HomeProxy 一样：标签是 LuCI 菜单的子项，标签条由框架渲染，
 * 这里只声明自己渲染哪一块内容。
 */
return service.View.extend({
	app: Object.assign({}, service.View.app, { tab: 'log' })
});
